/**
 * Guards for action.yml and every workflow file, the one part of the project that no
 * other test executes. The 0.1.0 artifact defect (a missing `include-hidden-files`, which
 * upload-artifact reports only as a warning) was invisible to CI by construction; these
 * assertions cover that defect class: the upload settings, the shape of the CLI
 * invocation, the output wiring, the pinned version and the pinned action SHAs.
 *
 * Limitation: this parses and inspects the files. It does not run the action, so
 * behaviour on a real runner is still verified only by running it against a deployment.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionPath = join(repoRoot, 'action.yml');
const actionText = readFileSync(actionPath, 'utf8');

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  shell?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface ActionFile {
  inputs?: Record<string, { description?: string; default?: unknown; required?: boolean }>;
  outputs?: Record<string, { description?: string; value?: string }>;
  runs?: { using?: string; steps?: Step[] };
}

const action = parse(actionText) as ActionFile;
const steps = action.runs?.steps ?? [];
const packageVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

/** `owner/repo@ref` lines, with the trailing comment when there is one. */
function usesLines(text: string): { ref: string; comment: string }[] {
  const found: { ref: string; comment: string }[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(#.*)?$/.exec(line);
    if (match?.[1] !== undefined) found.push({ ref: match[1], comment: match[2] ?? '' });
  }
  return found;
}

function workflowFiles(): string[] {
  const dirs = [join(repoRoot, '.github', 'workflows'), join(repoRoot, 'examples', 'workflows')];
  return dirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).map((f) => join(dir, f)));
}

describe('action.yml', () => {
  it('is a composite action whose steps all declare a shell or a uses', () => {
    expect(action.runs?.using).toBe('composite');
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      if (step.run !== undefined) expect(step.shell).toBe('bash');
      else expect(step.uses).toBeDefined();
    }
  });

  it('uses every input it declares', () => {
    const declared = Object.keys(action.inputs ?? {});
    expect(declared.length).toBeGreaterThan(0);
    const unused = declared.filter((name) => !actionText.includes(`inputs.${name}`));
    expect(unused).toEqual([]);
  });

  it('documents every input and output', () => {
    for (const [name, input] of Object.entries(action.inputs ?? {})) {
      expect(`${name}: ${input.description ?? ''}`.length, `input ${name} needs a description`).toBeGreaterThan(name.length + 20);
    }
    for (const [name, output] of Object.entries(action.outputs ?? {})) {
      expect(`${name}: ${output.description ?? ''}`.length, `output ${name} needs a description`).toBeGreaterThan(name.length + 20);
    }
  });

  it('uploads the hidden .scriptlock directory and fails when it finds nothing', () => {
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact') === true);
    expect(upload, 'the artifact upload step').toBeDefined();
    const withBlock = (upload?.with ?? {}) as Record<string, unknown>;
    // .scriptlock starts with a dot and upload-artifact has skipped hidden files by
    // default since v4.4. This is the 0.1.0 defect.
    expect(withBlock['include-hidden-files']).toBe(true);
    // warn is what kept that defect invisible: the run stayed green.
    expect(withBlock['if-no-files-found']).toBe('error');
    expect(String(withBlock['path'])).toContain('.scriptlock');
    expect(upload?.if).toContain('always()');
  });

  it('runs the CLI exactly once, as a diff, so the blocked-snapshot guard applies', () => {
    const cliSteps = steps.filter((step) => step.run?.includes('scriptlock "${args[@]}"') === true);
    expect(cliSteps).toHaveLength(1);
    const run = cliSteps[0]?.run ?? '';
    // `scriptlock scan --out` writes a challenge-page inventory over
    // last.<profile>.json; only `scriptlock diff` diverts it to blocked.<profile>.json.
    expect(run).toContain('args=(diff ');
    expect(run).not.toContain('args=(scan ');
    // One diff, and the history input decides in both directions, so a profile with
    // `history: true` still leaves exactly one line in the history index.
    expect(run).toContain('--no-history');
  });

  it('takes its outputs from a step that runs even when the diff failed', () => {
    for (const [name, output] of Object.entries(action.outputs ?? {})) {
      const match = /\$\{\{\s*steps\.([A-Za-z0-9_-]+)\.outputs\.[A-Za-z0-9_-]+\s*\}\}/.exec(String(output.value ?? ''));
      expect(match, `output ${name} must come from a step output`).not.toBeNull();
      const source = steps.find((step) => step.id === match?.[1]);
      expect(source, `output ${name} references step ${String(match?.[1])}`).toBeDefined();
      expect(source?.if, `the step behind output ${name} must run on every path`).toContain('always()');
    }
  });

  it('defaults the npm version to this package version rather than to a floating tag', () => {
    // Two scheduled runs of an evidence-producing control must be produced by the same
    // code; "latest" would silently change between them.
    expect(action.inputs?.['version']?.default).toBe(packageVersion);
  });

  it('pins every action it uses to a full commit SHA with the version in a comment', () => {
    const refs = usesLines(actionText);
    expect(refs.length).toBeGreaterThan(0);
    for (const { ref, comment } of refs) {
      expect(ref, `${ref} must be pinned to a 40-character commit SHA`).toMatch(/@[0-9a-f]{40}$/);
      expect(comment, `${ref} needs a "# vX.Y.Z" comment so Dependabot and readers can see the version`).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });
});

describe('workflow files', () => {
  const files = workflowFiles();

  it('finds the shipped workflows', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of files) {
    it(`${file.slice(repoRoot.length + 1)} parses and pins third-party actions by SHA`, () => {
      const text = readFileSync(file, 'utf8');
      const parsed = parse(text) as { jobs?: Record<string, unknown> };
      expect(parsed.jobs, 'a workflow needs jobs').toBeDefined();
      for (const { ref, comment } of usesLines(text)) {
        if (ref.startsWith('vladimirnizovtsev/scriptlock@')) {
          // The action is versioned by its git ref; the examples must point at a ref
          // that carries this release, not at an older one.
          expect(ref).toBe(`vladimirnizovtsev/scriptlock@v${packageVersion}`);
          continue;
        }
        expect(ref, `${file}: ${ref} must be pinned to a commit SHA`).toMatch(/@[0-9a-f]{40}$/);
        expect(comment, `${file}: ${ref} needs a "# vX.Y.Z" comment`).toMatch(/#\s*v\d+\.\d+\.\d+/);
      }
    });
  }

  it('checks out without leaving the job token in .git/config', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('actions/checkout@')) continue;
      expect(text, `${file}: actions/checkout needs persist-credentials: false`).toContain('persist-credentials: false');
    }
  });
});
