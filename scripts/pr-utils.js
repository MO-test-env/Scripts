
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
 * Rebases a PR branch onto its base branch using GitHub API.
 * Note: GitHub API cannot run "git rebase"; I manually replay commits.
 * * @param {object} github - The GitHub API client
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

    core.info(`PR #${prNumber}: ${prBranch} -> ${baseBranch}`);

    // Compare base ← PR 
    const comparison = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: baseBranch,
      head: prBranch
    });

    if (comparison.data.status !== "behind") {
      core.info("PR does not need rebase (not behind base).");
      return { rebaseNeeded: false, result: "skipped" };
    }

    core.info(`Rebase required: PR is behind by ${comparison.data.behind_by} commits.`);

    // We want ONLY the commits that are unique to the PR
    const prUniqueCommits = comparison.data.commits;

    if (prUniqueCommits.length === 0) {
      core.info("PR contains no unique commits.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // Get latest base branch SHA
    const { data: baseRef } = await github.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    let parentSha = baseRef.object.sha;
    let newTopSha = parentSha;

    core.info(`Replaying ${prUniqueCommits.length} commits…`);

    for (const commit of prUniqueCommits) {
      // Get original commit info
      const oldCommit = await github.rest.git.getCommit({
        owner,
        repo,
        commit_sha: commit.sha
      });

      // Create new commit with same message/tree but new parent
      const newCommit = await github.rest.git.createCommit({
        owner,
        repo,
        message: oldCommit.data.message,
        tree: oldCommit.data.tree.sha,
        parents: [parentSha],
        author: oldCommit.data.author,
        committer: oldCommit.data.committer
      });

      parentSha = newCommit.data.sha;
      newTopSha = newCommit.data.sha;
    }

    // Force-update PR branch to new top commit
    await github.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${prBranch}`,
      sha: newTopSha,
      force: true
    });

    core.info(`Rebase complete. New PR head: ${newTopSha}`);
    return { rebaseNeeded: true, result: "success", sha: newTopSha };

  } catch (error) {
    core.error(`Rebase failed: ${error.message}`);
    return { rebaseNeeded: true, result: "failed", error: error.message };
  }
}

module.exports = {
  apiSquashPR,
  apiRebasePR
};