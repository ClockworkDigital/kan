export function parseGithubBoardName(name: string) {
  const [, owner, repo] = /^GitHub: ([^/\s]+)\/([^/\s]+)$/.exec(name) ?? [];

  if (!owner || !repo) return null;

  return { owner, repo };
}
