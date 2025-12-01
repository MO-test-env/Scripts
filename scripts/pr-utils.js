
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
    const prHeadSha = pr.data.head.sha;
    
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
    
    // Check if rebase is needed
    if (commits.length > 0 && commits[0].parents[0].sha === baseSha) {
      core.info(`PR branch ${prBranch} is already based on latest ${baseBranch} commit (${baseSha})`);
      return { rebaseNeeded: false, result: "skipped", sha: prHeadSha };
    }
    
    // Get PR branch tree
    const { data: headCommit } = await github.rest.git.getCommit({
      owner,
      repo,
      commit_sha: prHeadSha
    });
    const prTreeSha = headCommit.tree.sha;
    
    // Create a new commit with the PR tree but based on the latest base branch commit
    const { data: newCommit } = await github.rest.git.createCommit({
      owner,
      repo,
      message: `Rebased ${prBranch} onto ${baseBranch} (${baseSha.substring(0, 7)})`,
      tree: prTreeSha,
      parents: [baseSha],
      author: {
        name: headCommit.author.name,
        email: headCommit.author.email,
        date: new Date().toISOString()
      }
    });
    
    // Update the PR branch reference to point to the new commit
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${prBranch}`,
      sha: newCommit.sha,
      force: true
    });
    
    core.info(`Rebase completed. PR branch ${prBranch} is now based on ${baseBranch} (${baseSha.substring(0, 7)})`);
    return { rebaseNeeded: true, result: "success", sha: newCommit.sha };
  } catch (error) {
    core.error(`Error rebasing PR: ${error.message}`);
    return { rebaseNeeded: true, result: "failed", error: error.message };
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

module.exports = {
  apiSquashPR,
  apiRebasePR,
  apiCherryPickPR
};