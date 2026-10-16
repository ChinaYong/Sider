import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersion } from './version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function planRelease({ repository, tag, sha, request }) {
  const base = `/repos/${repository}`;
  const release = await request(`${base}/releases/tags/${tag}`);
  if (release) {
    if (release.draft || release.prerelease) throw new Error(`${tag} already has a draft or prerelease; inspect it before publishing.`);
    return { publish: false, tagExists: true };
  }
  const ref = await request(`${base}/git/ref/tags/${tag}`);
  let object = ref?.object;
  // Resolve annotated tags as well as lightweight tags without moving either.
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    const annotation = await request(`${base}/git/tags/${object.sha}`);
    if (!annotation?.object) throw new Error(`Cannot resolve existing tag ${tag}.`);
    object = annotation.object;
  }
  if (ref && (object?.type !== 'commit' || object.sha !== sha)) {
    throw new Error(`Existing tag ${tag} does not point to this commit; use a new version.`);
  }
  return { publish: true, tagExists: Boolean(ref) };
}

export function githubRequest({ apiURL, token, fetchImpl = fetch }) {
  return async endpoint => {
    const response = await fetchImpl(`${apiURL}${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}) for ${endpoint}.`);
    return response.json();
  };
}

async function main() {
  const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, GITHUB_OUTPUT: output, GITHUB_REF_TYPE: refType, GITHUB_REF_NAME: refName } = process.env;
  if (!repository || !token || !output) throw new Error('Run this planner inside the Release workflow.');
  if (refType !== 'tag' && refName !== 'main') throw new Error('Automatic releases must run from main or a version tag.');
  const version = await checkVersion(root, refType === 'tag' ? refName : undefined);
  const tag = `v${version}`;
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const request = githubRequest({ apiURL: process.env.GITHUB_API_URL || 'https://api.github.com', token });
  const plan = await planRelease({ repository, tag, sha, request });
  await appendFile(output, `tag=${tag}\nsha=${sha}\npublish=${plan.publish}\ntag_exists=${plan.tagExists}\n`);
  console.log(plan.publish ? `Prepare ${tag} from ${sha}.` : `${tag} is already published; skipping.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
