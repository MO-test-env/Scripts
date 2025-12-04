/**
 * Squashes all commits in a PR into a single commit using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to squash
 * @returns {object} - Result object with squashNeeded and result properties
 */
/* async function apiSquashPR(github, core, owner, repo, prNumber) {
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
} */

/**
 * Rebases a PR branch on top of its target branch using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to rebase
 * @returns {object} - Result object with rebaseNeeded and result properties
 */
/* async function apiRebasePR(github, core, owner, repo, prNumber) {
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
} */

/**
 * Cherry-picks a PR branch onto the updated base branch using GitHub API
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {number} prNumber - The PR number to cherry-pick
 * @returns {object} - Result object with cherryPickNeeded and result properties
 */
/* async function apiCherryPickPR(github, core, owner, repo, prNumber) {
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
} */

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
 * @param {string} submodulePath - Optional path to submodule if this is a submodule merge (default empty string)
 * @returns {string} - Git status output
 * @throws {Error} - If there is an error
 */
async function localGitMergePipeline(core, remote, prNumber, tgtBranch, prBranch, isBase = false, submodules = [], owner = '', repo = '', submodulePath = '') {
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

  // Store the original working directory
  const originalCwd = process.cwd();
  
  // If this is a submodule merge, cd into the submodule path
  if (submodulePath) {
    core.info(`Changing directory to submodule path: ${submodulePath}`);
    try {
      process.chdir(submodulePath);
      core.info(`Successfully changed to submodule directory: ${process.cwd()}`);
    } catch (err) {
      core.warning(`Failed to validate submodule path ${submodulePath}: ${err.message}`);
    }
  }

  // Initialize PR info 
  // tgt branch, pr branch, pr title (append PR num), pr body 
  
  try {
    // Fetch the latest from remote for both branches
    core.info(`Fetching latest from remote for ${tgtBranch} and ${prBranch}...`);
    run(`git fetch --no-tags --deepen=99999 ${remote} ${tgtBranch}`);
    run(`git fetch --no-tags --deepen=99999 ${remote} ${prBranch}`);
    const st = run(`git status`);
    core.info(st);
    // Checkout PR branch
    core.info(`Checking out PR branch ${prBranch}...`);
    run(`git checkout -b ${prBranch} origin/${prBranch}`);
    
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
    // const mergeOutput = run(`git merge --ff-only ${prBranch}`);
    
    // Push changes to target branch
    core.info(`Pushing changes to ${tgtBranch}...`);
    // const pushOutput = run(`git push ${remote} ${tgtBranch}`);
    
    // Return the final status
    const finalOutput = `Successfully merged PR #${prNumber} from ${prBranch} into ${tgtBranch}`;
    core.info(finalOutput);
    return finalOutput;
    
  } catch (error) {
    core.error(`Error in git merge pipeline: ${error.message}`);
    throw error;
  }
  // Always cd back to the original working directory
  if (submodulePath) {
    core.info(`Changing directory back to original path: ${originalCwd}`);
    try {
      process.chdir(originalCwd);
      core.info(`Successfully returned to original directory: ${process.cwd()}`);
    } catch (err) {
      core.warning(`Failed to return to original directory: ${err.message}`);
    }
  }
}

/**
 * Checks the number of approvals and change requests for a PR
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {number} prNumber - The PR number to check
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @returns {object} - Object containing approvalCount and changeRequestCount
 */
async function checkPrApprovals(github, core, prNumber, owner, repo) {
  // Check approvals 
  const { data: reviews } = await github.rest.pulls.listReviews({
    owner: owner,
    repo: repo,
    pull_number: prNumber,
  });
  
  const latestByUser = {};
  for (const review of reviews) {
    latestByUser[review.user.login] = review.state;
  }
  const approvedUsers = Object.values(latestByUser).filter(s => s === 'APPROVED');
  const approvalCount = approvedUsers.length;
  const changeRequestCount = Object.values(latestByUser).filter(s => s === 'CHANGES_REQUESTED').length;
  
  return {
    approvalCount,
    changeRequestCount
  };
}

/**
 * Parses .gitmodules file and filters submodules based on changed paths
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {number} prNumber - The PR number (not used in this function)
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {string} baseRef - The base reference/branch
 * @returns {object} - Object containing filtered raw submodules
 */
async function initSubmodsFromGitModules(github, core, prNumber, owner, repo, baseRef, ) {
  // Load .gitmodules
  let content = "";
  try {
    const { data: f } = await github.rest.repos.getContent({
      owner: owner,
      repo: repo,
      path: ".gitmodules",
      ref: baseRef
    });

    content = Buffer.from(f.content, "base64").toString("utf8");
  } catch (err) {
    core.setFailed("Failed to load .gitmodules: " + err.message);
    throw err;
  }

  const lines = content.split("\n");
  const rawSubmodules = {};
  let current = null;

  for (const line of lines) {
    const sub = line.match(/\[submodule \"(.*)\"\]/);
    const path = line.match(/\s*path = (.*)/);
    const url = line.match(/\s*url = (.*)/);
    const br = line.match(/\s*branch = (.*)/);

    if (sub) {
      current = sub[1];
      rawSubmodules[current] = {};
    } else if (current && path) {
      rawSubmodules[current].path = path[1].trim();
    } else if (current && url) {
      rawSubmodules[current].url = url[1].trim();
    } else if (current && br) {
      rawSubmodules[current].configuredBranch = br[1].trim();
    }
  }

  core.info("Raw submodules from reading file:");
  core.info(JSON.stringify(rawSubmodules, null, 2));
  return rawSubmodules;
}

/**
 * Determines PR conflicts and changed submodules from PR diff
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {number} prNumber - The PR number to check
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @returns {object} - Object containing changed_submodules and base_ref
 */
async function getChangedSubmodules(github, core, prNumber, owner, repo) {
  // Get PR details and files
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const { data: files } = await github.rest.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 300 });

  // Collect all changed file paths
  const changedFilesSet = new Set();
  const changedSubmodulesSet = new Set();

  for (const f of files) {
    const filename = f.filename;
    changedFilesSet.add(filename);

    const parts = filename.split("/");
    const baseName = parts[parts.length - 1];

    // Treat files whose basename has no '.' as submodules
    if (baseName && !baseName.includes(".")) {
      changedSubmodulesSet.add(filename);
    }
  }

  const changedFiles = Array.from(changedFilesSet);
  const changedSubmodules = Array.from(changedSubmodulesSet);

  core.info(`Changed files: ${JSON.stringify(changedFiles)}`);
  core.info(`Changed submodules (no extension): ${JSON.stringify(changedSubmodules)}`);

  return {
    changed_submodules: changedSubmodules,
    changed_files: changedFiles,
    base_ref: pr.base.ref,
    pr_ref: pr.head.ref
  };
}

/**
 * Analyzes PR to find files with conflicts
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {number} prNumber - The PR number to check
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {Array<string>} submodulePaths - List of submodule paths to check against
 * @returns {object} - Object containing files_with_conflicts categorized by type and mergeable status
 */
async function getConflictedFiles(github, core, prNumber, owner, repo, submodulePaths = []) {
  // Get PR details including mergeability status
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  
  let filesWithConflicts = [];
  
  // Check if PR is mergeable
  if (pr.mergeable === false) {
    core.info(`PR #${prNumber} is not mergeable; analyzing possible conflicts...`);
    try {
      // detect potential conflicts
      const { data: comp } = await github.rest.repos.compareCommits({
        owner, repo, base: pr.base.ref, head: pr.head.ref
      });
      
      if (comp.status === "diverged") {
        const mergeBase = comp.merge_base_commit.sha;
        
        // Helper function that gets changed files for a sha
        const getChangedFiles = async (ref) => {
          try {
            const { data } = await github.rest.repos.compareCommits({
              owner, repo, base: mergeBase, head: ref
            });
            return new Set(data.files.map(f => f.filename));
          } catch {
            return new Set();
          }
        }; // end helper function

        const baseFiles = await getChangedFiles(pr.base.ref);
        const headFiles = await getChangedFiles(pr.head.ref);

        // Files modified in both branches are likely to have conflicts
        filesWithConflicts = Array.from(baseFiles).filter(file => headFiles.has(file));
        
        if (filesWithConflicts.length > 0) {
          core.info(`Found ${filesWithConflicts.length} potentially conflicting files via comparison API`);
          core.info(`Potentially conflicting files: ${JSON.stringify(filesWithConflicts)}`);
        }
      }
    } catch (err) {
      core.warning(`Could not compute conflict info: ${err.message}`);
    }
  } else {
    core.info(`PR #${prNumber} is mergeable, no conflicts detected`);
  }
  
  // Separate conflicts into submodule conflicts and non-submodule conflicts
  const submoduleConflicts = [];
  const nonSubmoduleConflicts = [];
  
  filesWithConflicts.forEach(filename => {
    // Check if this file is within a known submodule path
    const isInSubmodule = submodulePaths.some(subPath => 
      filename === subPath || filename.startsWith(`${subPath}/`)
    );
    
    if (isInSubmodule) {
      submoduleConflicts.push(filename);
    } else {
      nonSubmoduleConflicts.push(filename);
    }
  });

  const hasNonSubmoduleConflict = nonSubmoduleConflicts.length > 0;
  if (hasNonSubmoduleConflict) {
    core.setFailed(`❌ Conflicts in non-submodule files:\n${nonSubmoduleConflicts.join('\n')}`);
    throw new Error(`Workflow stopped because of base conflicts in non-submodule files:\n${nonSubmoduleConflicts.join('\n')}`);
  }

  core.info(`Submodule conflicts: ${JSON.stringify(submoduleConflicts)}`);
  core.info(`Non-submodule conflicts: ${JSON.stringify(nonSubmoduleConflicts)}`);

  return {
    files_with_conflicts: [...submoduleConflicts, ...nonSubmoduleConflicts],
    submodule_conflicts: submoduleConflicts,
    non_submodule_conflicts: nonSubmoduleConflicts,
    mergeable: pr.mergeable
  };
}

/**
 * Enriches submodule information with default branches, repoName, baseBranch, SHA, PRbranch, and PR number
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {object} rawSubmodules - Raw submodules object from initSubmodsFromGitModules
 * @param {string} baseRef - The base reference/branch
 * @param {string} prBranchRef - The PR branch reference
 * @param {boolean} isMergeIntoDefaultBranch - Whether this BASE PR is merging into the default branch
 * @returns {object} - Enriched submodules with additional information
 */
async function enrichSubmodules(github, core, owner, repo, rawSubmodules, baseRef, prBranchRef, isMergeIntoDefaultBranch = false) {
  
  let enriched = {};
  // Process each submodule
  for (const [name, data] of Object.entries(rawSubmodules)) {
    const { path, url, configuredBranch } = data;

    if (!path || !url) continue;

    // Get repository name from URL
    const repoName = await deriveRepoNameFromUrl(url);
    core.info(`Submodule ${name} resolves repoName: ${repoName}`);

    // Get default branch
    const subDefaultBranch = await getDefaultBranch(github, core, owner, repoName);
    if (!subDefaultBranch) continue;

    // Compute base branch
    const baseBranch = await computeBaseBranch(core, baseRef, subDefaultBranch, isMergeIntoDefaultBranch);

    // Initialize enriched submodule data
    enriched[name] = {
      path,
      url,
      repoName,
      configuredBranch,
      subDefaultBranch,
      baseBranch
    };

    try {
      // Get the SHA of the submodule from the PR branch
      const { data: prContent } = await github.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: prBranchRef 
      });

      if (!prContent || prContent.type !== "submodule") {
        // Not submodule change so ignore
        continue;
      }

      const sha = prContent.sha;

      // Find branches where the SHA is at the head
      const branchesContainingSha = await findBranchesForHeadCommit(github, core, owner, repoName, sha);

      // Check if SHA is on the base branch
      const isShaOnBaseBranch = await shaInBranch(github, owner, repoName, baseBranch, sha);
      core.info(`SHA ${sha} is on base branch ${baseBranch}: ${isShaOnBaseBranch}`);

      // Find all PRs associated with the commit
      const prs = await findPRsForCommit(github, core, owner, repoName, sha);

      // Determine PR branch and number
      const { prBranch, prNumber } = await determinePRBranchAndNumber(
        github, core, sha, repoName, baseBranch, isShaOnBaseBranch, branchesContainingSha, prs
      );

      // Update enriched submodule data
      enriched[name] = {
        ...enriched[name],
        sha,
        prBranch,
        prNumber
      };

      core.info(`Resolved ${name}: sha=${sha}, branch=${prBranch}, prNumber=${prNumber}`);
    } catch (err) {
      core.warning(`Error processing submodule ${name}: ${err.message}`);
    }
  }
  // for each submodule from changed submodules
  // get repo name from url 
  // get default branh 
  // get tgt branch - if base is mergeIntoDefault then that - otherwise use same as base 

  // add submod sha
  // add submod pr Branch 
  // get submod has PR num   

  return enriched;
}

/**
 * Derives repository name from URL
 * @param {string} url - Repository URL
 * @returns {string} - Repository name
 */
async function deriveRepoNameFromUrl(url) {
  let repoName = null;

  if (url.startsWith("https://github.com/")) {
    repoName = url.replace("https://github.com/", "")
                  .replace(".git", "")
                  .split("/")[1];
  } else if (url.startsWith("git@github.com:")) {
    repoName = url.replace("git@github.com:", "")
                  .replace(".git", "")
                  .split("/")[1];
  } else if (url.startsWith("../")) {
    repoName = url.replace("../", "").replace(".git", "");
  } else {
    repoName = url.split(/[\/:]/).pop().replace(".git", "");
  }

  return repoName;
}

/**
 * Gets default branch for a repository
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} owner - The organization name
 * @param {string} repoName - Repository name
 * @returns {string|null} - Default branch name or null if not found
 */
async function getDefaultBranch(github, core, owner, repoName) {
  try {
    const { data: repoInfo } = await github.rest.repos.get({
      owner,
      repo: repoName
    });
    return repoInfo.default_branch;
  } catch (err) {
    core.warning(`Failed repo lookup for ${repoName}: ${err.message}`);
    return null;
  }
}

/**
 * Computes base branch for a submodule
 * @param {object} core - The GitHub Actions core module
 * @param {string} baseRef - The base reference/branch
 * @param {string} subDefaultBranch - Submodule's default branch
 * @param {boolean} isMergeIntoDefaultBranch - Whether this is merging into default branch
 * @returns {string} - Base branch to use
 */
async function computeBaseBranch(core, baseRef, subDefaultBranch, isMergeIntoDefaultBranch) {
  if (isMergeIntoDefaultBranch) {
    core.info(`Using default branch '${subDefaultBranch}' for submodule`);
    return subDefaultBranch;
  } else {
    core.info(`Using PR base_ref '${baseRef}' for submodule`);
    return baseRef;
  }
}

/**
 * Checks if a SHA is anywhere on a branch (not only HEAD)
 * @param {object} github - The GitHub API client
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} branch - Branch name
 * @param {string} sha - SHA to check
 * @returns {boolean} - True if SHA is on branch, false otherwise
 */
async function shaInBranch(github, repoOwner, repoName, branch, sha) {
  try {
    const { data: commits } = await github.rest.repos.listCommits({
      owner: repoOwner,
      repo: repoName,
      sha: branch,
      per_page: 100
    });
    return commits.some(c => c.sha === sha);
  } catch (err) {
    return false;
  }
}

/**
 * Finds branches where a SHA is at the head
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} sha - SHA to check
 * @returns {string[]} - Array of branch names
 */
async function findBranchesForHeadCommit(github, core, repoOwner, repoName, sha) {
  try {
    core.info(`Attempting to find branches for head commit ${sha} in repository ${repoOwner}/${repoName}`);
    const { data: branches } = await github.rest.repos.listBranchesForHeadCommit({
      owner: repoOwner,
      repo: repoName,
      commit_sha: sha
    });
    const branchNames = branches.map(b => b.name);
    core.info(`Found ${branchNames.length} branch(es) containing SHA ${sha}: ${branchNames.join(', ')}`);
    return branchNames;
  } catch (err) {
    core.warning(`Could not list branches for head commit ${sha}: ${err.message}`);
    return [];
  }
}

/**
 * Finds PRs associated with a commit
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} repoOwner - Repository owner
 * @param {string} repoName - Repository name
 * @param {string} sha - SHA to check
 * @returns {object[]} - Array of PR objects
 */
async function findPRsForCommit(github, core, repoOwner, repoName, sha) {
  try {
    const { data: prList } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: repoOwner,
      repo: repoName,
      commit_sha: sha
    });
    return prList;
  } catch (err) {
    core.warning(`Unable to find PRs associated with ${sha}: ${err.message}`);
    return [];
  }
}

/**
 * Determines PR branch and number based on SHA
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {string} sha - Commit SHA
 * @param {string} repoName - Repository name
 * @param {string} baseBranch - Base branch
 * @param {boolean} isShaOnBaseBranch - Whether SHA is on base branch
 * @param {string[]} branchesContainingSha - Branches containing SHA
 * @param {object[]} prs - PRs associated with SHA
 * @returns {object} - Object containing PR branch and number
 */
async function determinePRBranchAndNumber(github, core, sha, repoName, baseBranch, isShaOnBaseBranch, branchesContainingSha, prs) {
  let prBranch = null;
  let prNumber = null;

  const openPRs = prs.filter(pr => pr.state === "open");
  const mergedPRs = prs.filter(pr => pr.merged_at);

  // SHA on delivery branch 
  if (isShaOnBaseBranch) {
    prBranch = baseBranch;
    prNumber = 0;
  }
  // SHA has exactly one open PR
  else if (openPRs.length === 1) {
    const prObj = openPRs[0];
    prBranch = prObj.head.ref;
    prNumber = prObj.number;

    // warning if head-of-branch contradicts PR branch
    if (branchesContainingSha.length === 1 && branchesContainingSha[0] !== prBranch) {
      core.warning(
        `SHA ${sha} is HEAD of '${branchesContainingSha[0]}' but open PR uses branch '${prBranch}'.`
      );
    }
  }
  // SHA has merged PR(s)
  else if (mergedPRs.length >= 1) {
    const latest = mergedPRs.sort(
      (a, b) => new Date(b.merged_at) - new Date(a.merged_at)
    )[0];

    prBranch = latest.head.ref;
    prNumber = latest.number;
  }
  // SHA is HEAD of exactly one branch → no PR yet
  else if (branchesContainingSha.length === 1) {
    prBranch = branchesContainingSha[0];
    prNumber = -1;
  }
  // SHA is HEAD of multiple branches → ambiguous
  else if (branchesContainingSha.length > 1) {
    core.setFailed(
      `SHA ${sha} is HEAD of multiple branches (${branchesContainingSha}) and has no PR.`
    );
  }
  // No PRs, not on head, not on base branch → fail
  else {
    core.setFailed(
      `Could not determine PR or branch for SHA ${sha}. Not on default branch, not head of branch, no PRs.`
    );
  }

  return { prBranch, prNumber };
}


/**
 * Determines PR conflicts and changed submodules from PR diff
 * Uses GitHub API to get files with conflicts from PR mergeability status 
 * @param {object} github - The GitHub API client
 * @param {object} core - The GitHub Actions core module
 * @param {number} prNumber - The PR number to check
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {boolean} isMergeIntoDefaultBranch - Whether this BASE PR is merging into the default branch
 * @returns {object} - Object containing changed_submodules and files_with_conflicts
 */
async function submodDiff(github, core, prNumber, owner, repo, isMergeIntoDefaultBranch) {
  // Get the changed submodules
  const { changed_submodules, changed_files, base_ref, pr_ref } = await getChangedSubmodules(github, core, prNumber, owner, repo);

  // Enrich submodule information only for submodules present in the changed paths
  const rawSubmodules = await initSubmodsFromGitModules(github, core, prNumber, owner, repo, base_ref);

  const filteredRawSubmodules = {};
  const changedPaths = new Set([
    ...(changed_files || []),
    ...(changed_submodules || [])
  ]);

  for (const [name, data] of Object.entries(rawSubmodules)) {
    if (!data || !data.path) continue;

    const subPath = data.path;
    // Consider this submodule "changed" if its path or a child path appears in the changed set
    const isChanged = Array.from(changedPaths).some(p => p === subPath || p.startsWith(`${subPath}/`));

    if (isChanged) {
      filteredRawSubmodules[name] = data;
    }
  }

  const enrichedSubmodules = await enrichSubmodules(github, core, owner, repo, filteredRawSubmodules, base_ref, pr_ref, isMergeIntoDefaultBranch);
  
  return {
    changed_submodules,
    enriched_submodules: enrichedSubmodules
  };
}

/**
 * Updates a GitHub comment by appending a message to it
 * @param {object} github - The GitHub API client
 * @param {number} commentId - The comment ID to update
 * @param {string} owner - The organization name
 * @param {string} repo - The repository name
 * @param {string} appendMsg - The message to append to the comment
 * @returns {void}
 */
async function appendComment(github, commentId, owner, repo, appendMsg) {
  // Get the existing comment
  const { data: comment } = await github.rest.issues.getComment({
    owner: owner,
    repo: repo,
    comment_id: commentId,
  });

  // Append the new message
  const newBody = comment.body + appendMsg;
  
  // Update the comment
  await github.rest.issues.updateComment({
    owner: owner,
    repo: repo,
    comment_id: commentId,
    body: newBody,
  });
}

// Export the functions
module.exports = {
  localGitMergePipeline, 
  checkPrApprovals, 
  initSubmodsFromGitModules,
  getChangedSubmodules,
  getConflictedFiles,
  submodDiff,
  deriveRepoNameFromUrl, 
  computeBaseBranch, 
  shaInBranch, 
  findBranchesForHeadCommit, 
  findPRsForCommit, 
  determinePRBranchAndNumber,
  enrichSubmodules, 
  appendComment,
};