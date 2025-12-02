/**
 * Squashes all commits in a PR into a single commit using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to squash
 * @returns {object} - Result object with squashNeeded and result properties
 */
async function apiSquashPR(github, core, owner, repo, prNumber) {
  try {
    const pr = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const { data: commits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });

    if (commits.length <= 1) {
      core.info("PR has only one commit; skipping squash.");
      return { squashNeeded: false, result: "skipped" };
    }

    core.info(`Found ${commits.length} commits in PR #${prNumber}`);

    const firstCommit = commits[0];
    const headCommit = commits[commits.length - 1];

    const { data: headCommitData } = await github.rest.git.getCommit({ owner, repo, commit_sha: headCommit.sha });
    const { data: firstCommitData } = await github.rest.git.getCommit({ owner, repo, commit_sha: firstCommit.sha });

    const parentSha = firstCommitData.parents[0].sha;
    core.info(`Using first PR commit's parent as squash parent: ${parentSha}`);

    const squashMessage = `${pr.data.title}\n\n${pr.data.body || ''}\n`;

    const author = headCommitData.author;
    core.info(`Preserving original author metadata: ${author.name} <${author.email}>`);
    // if (signature) core.info(`Preserving original commit signature`);

    let commitOptions = {
      owner,
      repo,
      message: squashMessage,
      tree: headCommitData.tree.sha,
      parents: [parentSha],
      author: { name: author.name, email: author.email, date: author.date }
    };

    const { data: newCommit } = await github.rest.git.createCommit(commitOptions);

    const branchRef = pr.data.head.ref;

    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branchRef}`, sha: newCommit.sha, force: true });

    core.info(`Squash completed. New commit: ${newCommit.sha}`);
    return { squashNeeded: true, result: "success", sha: newCommit.sha };
  } catch (error) {
    core.error(`Error squashing PR: ${error.message}`);
    throw error;
  }
}

/**
 * Rebases a PR branch on top of its target branch using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to rebase
 * @returns {object} - Result object with rebaseNeeded and result properties
 */
async function apiRebasePR(github, core, owner, repo, prNumber) {
  try {
    // Get PR info
    const pr = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const prBranch = pr.data.head.ref;
    const baseBranch = pr.data.base.ref;
    const { data: commits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });

    if (commits.length !== 1) {
      throw new Error(`PR must contain exactly 1 commit. Found ${commits.length}.`);
    }

    const prCommitSha = commits[0].sha;
    const { data: prCommitDetail } = await github.rest.repos.getCommit({ owner, repo, ref: prCommitSha });
    const changedFiles = prCommitDetail.files;
    if (!changedFiles || changedFiles.length === 0) {
      core.info("No files changed in PR commit, skipping rebase.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // --- Get base branch HEAD + tree ---
    const { data: baseRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    const baseSha = baseRef.object.sha;

    const { data: baseCommit } = await github.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
    const baseTreeSha = baseCommit.tree.sha;

    // BUILD TREE UPDATES (Only create blobs for files that differ from main)
    const treeUpdates = [];

    for (const file of changedFiles) {
      const filePath = file.filename;

      let prContent = "";
      let baseContent = "";

      // Get PR version of the file if it exists
      if (file.status !== "removed") {
        const prFile = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: prCommitSha });

        if (!Array.isArray(prFile.data) && prFile.data.type === "file") {
          prContent = Buffer.from(
            prFile.data.content,
            prFile.data.encoding
          ).toString("utf8");
        }
      }

      // Get base version of the file if it exists
      let baseExists = true;
      try {
        const baseFile = await github.rest.repos.getContent({ owner, repo, path: filePath, ref: baseBranch });

        if (!Array.isArray(baseFile.data) && baseFile.data.type === "file") {
          baseContent = Buffer.from(
            baseFile.data.content,
            baseFile.data.encoding
          ).toString("utf8");
        }
      } catch (e) {
        baseExists = false; // file does not exist in base
      }

      // Determine if the file is truly different
      const isDifferent =
        file.status === "removed" ||
        !baseExists ||
        prContent !== baseContent;

      if (!isDifferent) {
        core.info(`Skipping ${filePath}: unchanged relative to ${baseBranch}`);
        continue; // ignore this file
      }

      if (file.status === "removed") {
        // Remove file in the new commit
        treeUpdates.push({
          path: filePath,
          sha: null,
          mode: "100644",
          type: "blob"
        });
        continue;
      }

      // Create blob containing PR version of the file
      const blob = await github.rest.git.createBlob({ owner, repo, content: prContent, encoding: "utf-8" });

      treeUpdates.push({
        path: filePath,
        sha: blob.data.sha,
        mode: "100644",
        type: "blob"
      });
    }

    if (treeUpdates.length === 0) {
      core.info("Nothing to rebase; PR contains no differences from main.");
      return { rebaseNeeded: false, result: "skipped-no-changes" };
    }

    // Create new tree on top of base tree
    const { data: newTree } = await github.rest.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: treeUpdates });

    // Create new commit
    const { data: newCommit } = await github.rest.git.createCommit({
      owner,
      repo,
      message: commits[0].commit.message,
      tree: newTree.sha,
      parents: [baseSha],
      author: commits[0].commit.author,
      committer: commits[0].commit.committer
    });

    // Update the PR branch
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${prBranch}`, sha: newCommit.sha, force: true });

    core.info(`Rebased PR branch ${prBranch} onto ${baseBranch}`);

    return {
      rebaseNeeded: true,
      result: "success",
      sha: newCommit.sha
    };

  } catch (err) {
    core.error(`Rebase failed: ${err.message}`);
    return { rebaseNeeded: true, result: "failed", error: err.message };
  }
}

/**
 * Cherry-picks a PR branch onto the updated base branch using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to cherry-pick
 * @returns {object} - Result object with cherryPickNeeded and result properties
 */
async function apiCherryPickPR(github, core, owner, repo, prNumber) {
  try {
    // Get PR info
    const pr = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const prBranch = pr.data.head.ref;
    const baseBranch = pr.data.base.ref;
    
    // Get latest base branch commit
    const { data: baseRef } = await github.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });
    const baseSha = baseRef.object.sha;
    
    // Get PR commits
    const { data: commits } = await github.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber
    });
    
    // Check if cherry-pick is needed
    if (commits.length === 0) {
      core.info(`PR #${prNumber} has no commits to cherry-pick`);
      return { cherryPickNeeded: false, result: "skipped" };
    }
    
    // Get the current state of the PR branch
    const { data: prRef } = await github.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${prBranch}`
    });
    const originalPrSha = prRef.object.sha;
    
    // Create a temporary branch based on the latest base branch
    const tempBranch = `temp-cherry-pick-${prNumber}-${Date.now()}`;
    await github.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${tempBranch}`,
      sha: baseSha
    });
    
    // Apply each commit from the PR to the temporary branch
    let currentSha = baseSha;
    for (const commit of commits) {
      const { data: commitData } = await github.rest.git.getCommit({
        owner,
        repo,
        commit_sha: commit.sha
      });
      
      // Get the tree for this commit
      const { data: commitTree } = await github.rest.git.getTree({
        owner,
        repo,
        tree_sha: commitData.tree.sha,
        recursive: 1
      });
      
      // Create a new commit with the same changes but based on the current SHA
      const { data: newCommit } = await github.rest.git.createCommit({
        owner,
        repo,
        message: commitData.message,
        tree: commitData.tree.sha,
        parents: [currentSha],
        author: {
          name: commitData.author.name,
          email: commitData.author.email,
          date: commitData.author.date
        }
      });
      
      currentSha = newCommit.sha;
      
      // Update the temporary branch to point to this new commit
      await github.rest.git.updateRef({
        owner,
        repo,
        ref: `heads/${tempBranch}`,
        sha: currentSha
      });
    }
    
    // Now update the PR branch to point to the temporary branch's HEAD
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${prBranch}`,
      sha: currentSha,
      force: true
    });
    
    // Delete the temporary branch
    await github.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${tempBranch}`
    });
    
    core.info(`Cherry-pick completed. PR branch ${prBranch} changes have been applied on top of the latest ${baseBranch}`);
    return { cherryPickNeeded: true, result: "success", sha: currentSha };
  } catch (error) {
    core.error(`Error cherry-picking PR: ${error.message}`);
    return { cherryPickNeeded: true, result: "failed", error: error.message };
  }
}

/**
 * Mimic the API call to merge code, but use the separate git commands squash, rebase (with submodule ptr conflict resolution), merge --ff-only, sign and push
 * @param {object} core - The GitHub Actions core module
 * @param {string} remote - Remote name
 * @param {string} tgtBranch - Target or base branch ex Main
 * @param {string} prBranch - PR branch ex. adc/users/marissao/cdc-2342
 * @param {number} prNumber - The PR number to merge
 * @param {boolean} isBase - Whether the PR is a base repo (has submodules) or not (default false)
 * @param {Array<string>} submodules - Array of submodule paths to handle
 * @param {string} owner - The organization or user name (optional)
 * @param {string} repo - The repository name (optional)
 * @returns {string} - Git status output
 * @throws {Error} - If there is an error
 */
async function localGitMergePipeline(core, remote, tgtBranch, prBranch, prNumber, isBase = false, submodules = [], owner = '', repo = '') {
  const { execSync } = require('child_process');
  
  // Helper function to run git commands with better error handling
  const run = (cmd, opts = {}) => {
    const stdio = opts.stdio ?? 'pipe';
    const encoding = opts.encoding ?? 'utf8';
    const cwd = opts.cwd ?? process.cwd();
    core.info(`$ ${cmd}`);
    try {
      return execSync(cmd, { stdio, encoding, cwd }).trim();
    } catch (err) {
      // Allow graceful failure for specific commands that might fail but we want to continue
      if (!opts.allowFail) throw err;
      core.warning(`⚠️ Command failed (continuing): ${cmd}`);
      core.warning(err.stdout || err.message);
      return '';
    }
  };

  // Initialize PR info 
  // tgt branch, pr branch, pr title (append PR num), pr body 
  
  try {
    // Fetch the latest from remote for both branches
    core.info(`Fetching latest from remote for ${tgtBranch} and ${prBranch}...`);
    run(`git fetch ${remote} ${tgtBranch}:refs/remotes/origin/${tgtBranch}`);
    run(`git fetch ${remote} ${prBranch}:refs/remotes/origin/${prBranch}`);
    
    // Checkout PR branch
    core.info(`Checking out PR branch ${prBranch}...`);
    run(`git checkout ${prBranch}`);
    
    // Update submodules if this is a base repo
    if (isBase && submodules.length > 0) {
      core.info(`Updating submodules: ${submodules.join(', ')}...`);
      run(`git submodule update --init --recursive ${submodules.join(' ')}`);
    }
    
    // Find merge base and count commits
    const base = run(`git merge-base HEAD origin/${tgtBranch}`);
    const commitCount = parseInt(run(`git rev-list --count ${base}..HEAD`), 10);
    core.info(`Commit count in PR: ${commitCount}`);
    
    // Squash commits if there are multiple
    if (commitCount > 1) {
      core.info('Multiple commits detected — performing squash.');
      const msgs = run(`git log --reverse --pretty=format:"%s%n%b" ${base}..HEAD`);
      const prTitle = `PR #${prNumber}`;
      run(`git reset --soft ${base}`);
      run(`git commit -m "${prTitle} - Squash" -m "${msgs.replace(/"/g, '\"')}"`);
    } else {
      core.info('Only one commit — skipping squash.');
    }
    
    // Rebase onto target branch
    core.info(`Starting rebase onto origin/${tgtBranch}...`);
    
    if( isBase && submodules.length > 0 ) {
      run(`git rebase origin/${tgtBranch}`, { allowFail: true });
      // Handle conflicts if any
      let hadSubConflicts = false;
      let conflicted = run(`git diff --name-only --diff-filter=U`, { allowFail: true }).split('\n').filter(Boolean);
      
      if (conflicted.length > 0) {
        core.warning(`⚠️ Rebase conflicts detected: ${conflicted.join(', ')}`);
        
        // Separate submodule conflicts from other conflicts
        const subConflicts = isBase ? 
          conflicted.filter(f => submodules.some(s => f === s || f.startsWith(`${s}/`))) : [];
        const nonSubConflicts = conflicted.filter(f => !submodules.some(s => f === s || f.startsWith(`${s}/`)));
        
        // Set flag if we have submodule conflicts
        hadSubConflicts = subConflicts.length > 0;
        
        // Non-submodule conflicts require manual intervention
        if (nonSubConflicts.length > 0) {
          core.setFailed(`❌ Rebase conflicts in non-submodule files:\n${nonSubConflicts.join('\n')}`);
          core.setOutput('failMsg', `Workflow stopped because rebase conflicts in non-submodule files:\n${nonSubConflicts.join('\n')}`);
          process.exit(1);
        }
        
        // Auto-resolve submodule conflicts
        if (subConflicts.length > 0) {
          core.info(`Submodule conflicts only — auto-resolving.`);
          subConflicts.forEach(sub => run(`git add "${sub}"`));
          run(`git commit --no-edit`);
          run(`git rebase --continue`, { allowFail: true });
        }
      } else {
        core.info('No rebase conflicts detected.');
        // Final validation
        let rebaseSuccessful = false;
        try {
          const finalRebase = run(`git rebase origin/${tgtBranch}`, { allowFail: true });
          if (/up to date/i.test(finalRebase) || /no rebase in progress/i.test(finalRebase)) {
            core.info('Branch already up to date — Confirmed no more conflicts.');
            rebaseSuccessful = true;
          } else if (finalRebase.includes('error') || finalRebase.includes('conflict')) {
            core.setFailed('❌ Rebase failed — unresolved conflicts remain.');
            core.setOutput('failMsg', 'Unresolved conflicts remain after rebase.');
            process.exit(1);
          } else {
            rebaseSuccessful = true;
          }
        } catch (err) {
          core.setFailed('❌ Rebase failed — unresolved conflicts remain.');
          core.setOutput('failMsg', 'Unresolved conflicts remain after rebase.');
          process.exit(1);
        }
        
        // Push changes to PR branch if needed
        if (hadSubConflicts && rebaseSuccessful) {
          core.info('Pushing changes with --force-with-lease because submodule conflicts were resolved');
          run(`git push ${remote} ${prBranch} --force-with-lease`);
        } else if (rebaseSuccessful) {
          core.info('Pushing rebased changes to PR branch');
          run(`git push ${remote} ${prBranch} --force-with-lease`);
        }
      }
    } else {
      run(`git rebase origin/${tgtBranch}`, { allowFail: false });
    }

    // Checkout target branch and update
    core.info(`Checking out target branch ${tgtBranch}...`);
    run(`git checkout ${tgtBranch}`);
    run(`git pull ${remote} ${tgtBranch}`);
    
    // Merge PR branch into target branch with fast-forward only
    core.info(`Merging PR branch ${prBranch} into ${tgtBranch} with fast-forward only...`);
    /**
     * The fast forward flag is integral to merging without a merge commit - Mimics cherry pick operation because we just squashed/rebased/pushed PR
     * Based on the documentation linked below, this command in combination with a newly rebased code is the only non API way to get the PR to be marked as merged.    
     * https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges#indirect-merges
     */
    const mergeOutput = run(`git merge --ff-only ${prBranch}`);
    
    // Push changes to target branch
    core.info(`Pushing changes to ${tgtBranch}...`);
    const pushOutput = run(`git push ${remote} ${tgtBranch}`);
    
    // Return the final status
    const finalOutput = `Successfully merged PR #${prNumber} from ${prBranch} into ${tgtBranch}`;
    core.info(finalOutput);
    return finalOutput;
    
  } catch (error) {
    core.error(`Error in git merge pipeline: ${error.message}`);
    throw error;
  }
}


/**
 * Updates submodules to the top of their target branches and commits any changes
 * @param {object} core - The GitHub Actions core module
 * @param {string} remote - Remote name (e.g., 'origin')
 * @param {Array<object>} submodules - Array of submodule objects with path and targetBranch properties
 * @param {string} commitMessage - Message for the commit if changes are detected
 * @param {boolean} pushChanges - Whether to push changes to remote (default: false)
 * @returns {object} - Result object with updated submodules and status
 * @throws {Error} - If there is an error
 */
async function localGitBumpSubmodules(core, remote, submodules, commitMessage, pushChanges = false) {
  const { execSync } = require('child_process');
  
  // Helper function to run git commands with better error handling
  const run = (cmd, opts = {}) => {
    const stdio = opts.stdio ?? 'pipe';
    const encoding = opts.encoding ?? 'utf8';
    const cwd = opts.cwd ?? process.cwd();
    core.info(`$ ${cmd}`);
    try {
      return execSync(cmd, { stdio, encoding, cwd }).trim();
    } catch (err) {
      // Allow graceful failure for specific commands that might fail but we want to continue
      if (!opts.allowFail) throw err;
      core.warning(`⚠️ Command failed (continuing): ${cmd}`);
      core.warning(err.stdout || err.message);
      return '';
    }
  };

  // Store original branch to return to it later
  const originalBranch = run('git rev-parse --abbrev-ref HEAD');
  core.info(`Current branch: ${originalBranch}`);
  
  // Initialize results
  const result = {
    updatedSubmodules: [],
    noChanges: [],
    errors: [],
    status: 'success'
  };
  
  try {
    // Make sure we have the latest from remote
    core.info('Fetching latest from remote...');
    run(`git fetch ${remote}`);
    
    // Process each submodule
    for (const submodule of submodules) {
      const { path, targetBranch } = submodule;
      
      if (!path || !targetBranch) {
        core.warning(`⚠️ Skipping submodule with missing path or targetBranch: ${JSON.stringify(submodule)}`);
        result.errors.push(`Invalid submodule config: ${JSON.stringify(submodule)}`);
        continue;
      }
      
      core.info(`Processing submodule: ${path} (target branch: ${targetBranch})`);
      
      try {
        // Enter the submodule directory
        core.info(`Entering submodule directory: ${path}`);
        const cwd = process.cwd();
        process.chdir(path);
        
        // Fetch the latest from remote for the target branch
        core.info(`Fetching latest for ${targetBranch}...`);
        run(`git fetch ${remote} ${targetBranch}`);
        
        // Get current commit
        const currentCommit = run('git rev-parse HEAD');
        core.info(`Current commit: ${currentCommit.substring(0, 8)}`);
        
        // Get latest commit on target branch
        const latestCommit = run(`git rev-parse ${remote}/${targetBranch}`);
        core.info(`Latest commit on ${targetBranch}: ${latestCommit.substring(0, 8)}`);
        
        // Check if we need to update
        if (currentCommit !== latestCommit) {
          core.info(`Updating submodule ${path} to latest on ${targetBranch}...`);
          
          // Checkout the target branch
          run(`git checkout ${targetBranch}`);
          
          // Pull the latest changes
          run(`git pull ${remote} ${targetBranch}`);
          
          // Go back to parent repo directory
          process.chdir(cwd);
          
          // Stage the submodule change
          run(`git add ${path}`);
          
          result.updatedSubmodules.push({
            path,
            previousCommit: currentCommit.substring(0, 8),
            newCommit: latestCommit.substring(0, 8)
          });
        } else {
          core.info(`Submodule ${path} is already at the latest commit on ${targetBranch}`);
          process.chdir(cwd);
          result.noChanges.push(path);
        }
      } catch (err) {
        core.warning(`⚠️ Error processing submodule ${path}: ${err.message}`);
        result.errors.push(`${path}: ${err.message}`);
        // Make sure we're back in the parent repo directory
        try {
          process.chdir(cwd);
        } catch (e) {
          // Ignore errors when trying to change back to cwd
        }
      }
    }
    
    // Commit changes if any submodules were updated
    if (result.updatedSubmodules.length > 0) {
      core.info('Committing submodule updates...');
      const message = commitMessage || `Update submodules to latest on their target branches\n\nUpdated: ${result.updatedSubmodules.map(s => s.path).join(', ')}`;
      run(`git commit -m "${message}"`);
      
      // Push changes if requested
      if (pushChanges) {
        core.info('Pushing submodule updates to remote...');
        run(`git push ${remote} ${originalBranch}`);
      }
      
      core.info('Submodule updates committed successfully.');
    } else {
      core.info('No submodule updates to commit.');
    }
    
    // Return to original branch if we're not already on it
    const currentBranch = run('git rev-parse --abbrev-ref HEAD');
    if (currentBranch !== originalBranch) {
      core.info(`Returning to original branch: ${originalBranch}`);
      run(`git checkout ${originalBranch}`);
    }
    
  } catch (error) {
    core.error(`Error in git bump submodules: ${error.message}`);
    result.status = 'failed';
    result.errors.push(error.message);
  }
  
  return result;
}

// Export the functions
module.exports = {
  apiSquashPR,
  apiRebasePR,
  apiCherryPickPR,
  localGitMergePipeline, 
  localGitBumpSubmodules, 
};