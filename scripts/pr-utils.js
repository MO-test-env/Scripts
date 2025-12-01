
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
    const committer = headCommitData.committer;
    const signature = headCommitData.verification?.signature || null;
    const payload = headCommitData.verification?.payload || null;

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

    // This works on github.com but the signature cant be verified in enterprise env - still in dev- MO :)
    // if (signature && payload) {
    //   commitOptions.signature = signature;
    //}

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
 * Simple single-commit rebase mimic for GitHub Actions.
 * 
 * Repeats the PR's single commit on top of the latest base branch.
 */
async function apiCherryPickToRebasePR(github, core, owner, repo, prNumber) {
  try {
    core.info(`Rebasing PR #${prNumber} ...`);

    // Get PR info
    const pr = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const prBranch = pr.data.head.ref;
    const baseBranch = pr.data.base.ref;

    // Ensure PR has exactly 1 commit (your assumption)
    const { data: commits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });

    if (commits.length !== 1) {
      throw new Error(`PR must contain exactly one commit – found ${commits.length}`);
    }

    const prCommitSha = commits[0].sha;

    // Get details for that commit (contains file list)
    const { data: commitDetail } = await github.rest.repos.getCommit({ owner, repo, ref: prCommitSha });

    const changedFiles = commitDetail.files;
    if (!changedFiles || changedFiles.length === 0) {
      core.info("No file changes in commit; nothing to rebase.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // Get base branch HEAD commit + tree
    const baseRef = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}`});
    const baseSha = baseRef.data.object.sha;
    const baseCommit = await github.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
    const baseTreeSha = baseCommit.data.tree.sha;
    core.info(`Rebasing commit ${prCommitSha} onto ${baseBranch} (${baseSha})`);

    //
    // Build tree entries from changed files. This is the ENTIRE rebase.
    // For each changed file, grab the content AS OF the PR commit
    //
    const treeUpdates = [];

    for (const file of changedFiles) {
      if (file.status === "removed") {
        // Mark file as deleted in the new commit
        treeUpdates.push({
          path: file.filename,
          sha: null,       // null = delete file
          mode: "100644",
          type: "blob"
        });
        continue;
      }

      // Fetch file content at the PR commit SHA
      const fileContent = await github.rest.repos.getContent({ owner, repo, path: file.filename, ref: prCommitSha });

      if (Array.isArray(fileContent.data) || fileContent.data.type !== "file") {
        throw new Error(`Unexpected file type (not a file): ${file.filename}`);
      }

      const decodedContent = Buffer.from(
        fileContent.data.content,
        fileContent.data.encoding
      ).toString("utf8");

      // Create a blob for the rebased commit
      const blob = await github.rest.git.createBlob({
        owner,
        repo,
        content: decodedContent,
        encoding: "utf-8"
      });

      treeUpdates.push({
        path: file.filename,
        sha: blob.data.sha,
        mode: "100644",
        type: "blob"
      });
    }

    // Create new tree on top of the base tree
    const newTree = await github.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha,
      tree: treeUpdates
    });

    // Create a new commit on top of the base branch
    const newCommit = await github.rest.git.createCommit({
      owner,
      repo,
      message: commits[0].commit.message,
      tree: newTree.data.sha,
      parents: [baseSha],
      author: commits[0].commit.author,
      committer: commits[0].commit.committer
    });

    core.info(`New rebased commit created: ${newCommit.data.sha}`);

    // Force-update PR branch to point at the new rebased commit
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${prBranch}`,
      sha: newCommit.data.sha,
      force: true
    });

    core.info(`PR branch ${prBranch} rebased onto ${baseBranch}`);

    return {
      rebaseNeeded: true,
      result: "success",
      sha: newCommit.data.sha
    };

  } catch (err) {
    core.error(`Rebase failed: ${err.message}`);
    return {
      rebaseNeeded: true,
      result: "failed",
      error: err.message
    };
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

    core.info(`PR #${prNumber} branch: ${prBranch}`);
    core.info(`Target branch: ${baseBranch}`);
    
    // Get comparison data to determine merge base commit
    const { data: comparison } = await github.rest.repos.compareCommits({ owner, repo, base: baseBranch, head: prBranch});
    core.info(`Rebase status check: ${comparison.status}`);

    // Get the merge base commit (common ancestor)
    const mergeBaseCommitSha = comparison.merge_base_commit.sha;
    core.info(`Merge base commit: ${mergeBaseCommitSha}`);

    // Get all commits in PR branch
    const { data: prCommits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });

    if (prCommits.length === 0) {
      core.info("PR has no commits; skipping rebase.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    core.info(`PR branch needs rebasing (status: ${comparison.status}).`);

    // Get latest commit SHA of the target branch
    const { data: baseRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    let parentSha = baseRef.object.sha;
    let newCommitSha;
    core.info(`Base branch ${baseBranch} HEAD is at ${parentSha}`);

    for (const commit of prCommits) {
      // Get commit tree
      const { data: commitData } = await github.rest.git.getCommit({ owner, repo, commit_sha: commit.sha });

      // Create a new commit on top of the current parent
      const { data: newCommit } = await github.rest.git.createCommit({
        owner,
        repo,
        message: commit.commit.message,
        tree: commitData.tree.sha,
        parents: [parentSha],
        author: commit.commit.author,
        committer: commit.commit.committer
      });

      // Update our parent pointer to this new commit
      parentSha = newCommit.sha;
      newCommitSha = newCommit.sha;
      
      core.info(`Created new commit: ${newCommit.sha}`);
    }

    // If no commits were created, nothing was rebased
    if ( !newCommitSha) {
      core.warning("No commits were rebased.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // Update PR branch to point at the new commit chain
    core.info(`Updating PR branch ${prBranch} to point at new commit ${newCommitSha}`);
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${prBranch}`,
      sha: newCommitSha,
      force: true
    });

    core.info(`Rebase completed. PR branch ${prBranch} is now based on ${baseBranch}`);
    return { rebaseNeeded: true, result: "success", sha: newCommitSha };
  } catch (error) {
    core.error(`Error rebasing PR: ${error.message}`);
    return { rebaseNeeded: true, result: "failed", error: error.message };
  }
}

module.exports = {
  apiSquashPR,
  apiCherryPickToRebasePR,
  apiRebasePR
};