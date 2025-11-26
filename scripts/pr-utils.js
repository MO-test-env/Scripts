
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

    // Get all commits in PR branch
    const { data: prCommits } = await github.rest.pulls.listCommits({ owner, repo, pull_number: prNumber });

    if (prCommits.length === 0) {
      core.info("PR has no commits; skipping rebase.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // Compare PR with base
    const comparison = await github.rest.repos.compareCommits({
      owner,
      repo,
      base: baseBranch,
      head: prBranch
    });

    // identical = nothing to rebase
    // ahead | behind | diverged = rebase needed
    if (comparison.data.status === "identical") {
      core.info(`PR is identical to ${baseBranch}; skipping rebase.`);
      return { rebaseNeeded: false, result: "skipped" };
    }

    core.info(`Rebase needed (status = ${comparison.data.status}).`);

    // Determine the list of commits unique to the PR
    const prOnlyCommits = comparison.data.commits.filter(
      c => !c.parents.some(p => p.sha === comparison.data.merge_base_commit.sha)
    );

    if (prOnlyCommits.length === 0) {
      core.info("No unique PR commits to replay; skipping.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    core.info(`PR branch needs rebasing (status: ${comparison.data.status}).`);

    // Get latest commit SHA of the target branch
    const { data: baseRef } = await github.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
    let parentSha = baseRef.object.sha;
    let newCommitSha = null;

    for (const commit of prCommits) {
      // Get commit tree
      const { data: commitData } = await github.rest.git.getCommit({ owner, repo, commit_sha: commit.sha });

      // Prevent rebasing merge commits (GitHub API does not support recreating them)
      if (commitData.parents.length !== 1) {
        core.warning(`Skipping merge commit ${commit.sha}`);
        continue;
      }

      // Create a new commit with original tree but new parent
      const { data: newCommit } = await github.rest.git.createCommit({
        owner,
        repo,
        message: commit.commit.message,
        tree: commitData.tree.sha,
        parents: [parentSha],
        author: commit.commit.author,
        committer: commit.commit.committer
      });

      parentSha = newCommit.sha;
      newCommitSha = newCommit.sha;
    }

    if (!newCommitSha) {
      core.warning("Nothing was rebased; no commits created.");
      return { rebaseNeeded: false, result: "skipped" };
    }

    // Update PR branch to point at new commit
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
  apiRebasePR
};