import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, link, lstat, open, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./native-host-fixture.sh', import.meta.url));
const FRAME_LIMIT = 12 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const ENCODED_LIMIT = Math.ceil(IMAGE_LIMIT / 3) * 4 + 32;
const QUOTA = 256 * 1024 * 1024;
const MARKER = '.omarchy-browser-theme';
const colors = { background: '#112233', foreground: '#DDEEFF', accent: '#445566' };
const toml = 'background = "#112233"\nforeground = "#ddeeff"\naccent = "#445566"\n';
// The host checks signatures, not full image decoding.
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46494600', 'hex');

function webp(signature = 'VP8 ', chunkSize = 10) {
  const image = Buffer.alloc(20 + chunkSize + chunkSize % 2);
  image.write('RIFF');
  image.writeUInt32LE(image.length - 8, 4);
  image.write('WEBP', 8);
  image.write(signature, 12);
  image.writeUInt32LE(chunkSize, 16);
  return image;
}

function frame(message, advertisedLength) {
  const body = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(advertisedLength ?? body.length);
  return Buffer.concat([header, body]);
}

function parseFrames(buffer) {
  const messages = [];
  for (let offset = 0; offset < buffer.length;) {
    assert.ok(buffer.length - offset >= 4, 'complete response header');
    const length = buffer.readUInt32LE(offset);
    offset += 4;
    assert.ok(length > 0 && length <= 1024 * 1024, 'bounded response');
    assert.ok(buffer.length - offset >= length, 'complete response body');
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString()));
    offset += length;
  }
  return messages;
}

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'omarchy-native-host-test-'));
  const home = join(root, 'home');
  const themes = join(home, '.config/omarchy/themes');
  const state = join(home, '.local/state/omarchy/browser-theme-host');
  const records = join(state, 'themes');
  const icons = join(root, 'icons');
  const current = join(home, '.local/state/omarchy/current');
  const env = {
    ...process.env, TEST_ROOT: root, TEST_NOW: '1800000000', HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_RUNTIME_DIR: join(root, 'runtime'),
    TMPDIR: join(root, 'tmp'), OMARCHY_PATH: join(root, 'omarchy'),
  };
  delete env.BASH_ENV;
  delete env.ENV;
  for (const path of [themes, current, icons, env.XDG_RUNTIME_DIR, env.TMPDIR, join(env.OMARCHY_PATH, 'themes'), join(env.OMARCHY_PATH, 'bin')]) {
    await mkdir(path, { recursive: true });
  }
  t.after(() => rm(root, { recursive: true, force: true }));

  async function run(input = Buffer.alloc(0), overrides = {}) {
    const child = spawn('/bin/bash', [fixture], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const finished = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      child.stdin.end(input);
      const exit = await finished;
      assert.equal(exit.signal, null, Buffer.concat(stderr).toString());
      assert.equal(exit.code, 0, Buffer.concat(stderr).toString());
      const messages = parseFrames(Buffer.concat(stdout));
      return { messages, results: messages.filter(m => m.type === 'theme-result'), stderr: Buffer.concat(stderr).toString() };
    } finally {
      clearTimeout(timer);
      child.kill('SIGKILL');
    }
  }
  const install = (name = 'Review', extra = {}, overrides = {}) => run(frame({ type: 'install-theme', id: 'install', name, colors, ...extra }), overrides);
  async function expire() {
    await writeFile(join(state, 'last-install'), `${Number(env.TEST_NOW) - 3}\n`);
  }
  async function clean() {
    assert.deepEqual((await readdir(themes)).filter(name => name.startsWith('.omarchy-browser-stage.')), []);
    assert.deepEqual(await readdir(env.TMPDIR), []);
    assert.equal(await exists(join(state, '.last-install.tmp')), false);
    assert.equal(await exists(join(state, '.theme-record.tmp')), false);
    assert.equal(await exists(join(root, 'reservation-missing')), false);
  }
  return { root, home, themes, state, records, icons, current, env, run, install, expire, clean };
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function markedTheme(path) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, MARKER), '1\n');
  await writeFile(join(path, 'colors.toml'), toml);
}

async function membership(s, slug, value = '1\n') {
  await mkdir(s.records, { recursive: true, mode: 0o700 });
  await writeFile(join(s.records, slug), value, { mode: 0o600 });
}

function usage(path) {
  return Number(execFileSync('du', ['-sb', '--', path], { encoding: 'utf8' }).split('\t')[0]);
}

async function sparse(path, size) {
  const file = await open(path, 'w');
  try { await file.truncate(size); } finally { await file.close(); }
}

test('valid install creates only generated files, releases its lock, and can be set later', async t => {
  const s = await sandbox(t);
  const installed = await s.install('Review_1.0+Blue');
  assert.equal(installed.results[0].ok, true);
  const target = join(s.themes, 'review_1.0+blue');
  assert.deepEqual(await readdir(target), ['colors.toml']);
  assert.equal(await readFile(join(target, 'colors.toml'), 'utf8'), toml);
  assert.equal(await readFile(join(s.records, 'review_1.0+blue'), 'utf8'), '1\n');
  assert.equal((await lstat(s.records)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(s.records, 'review_1.0+blue'))).mode & 0o777, 0o600);
  assert.equal(await exists(join(s.root, 'reserved-before-publication')), true);
  assert.equal(await exists(join(s.root, 'lock-leak')), false);
  const result = await s.run(frame({ type: 'set-theme', id: 'set', name: 'Review_1.0+Blue' }));
  assert.equal(result.results[0].ok, true);
  assert.equal((await readFile(join(s.root, 'setter-calls'), 'utf8')).split('\n').filter(Boolean).length, 2);
  await s.clean();
});

for (const [label, extra, image, extension] of [
  ['no images', {}, null],
  ['empty backgrounds', { backgrounds: [] }, null],
  ['legacy empty background', { background: '' }, null],
  ['one PNG', { backgrounds: [png.toString('base64')] }, png, 'png'],
  ['one JPEG', { backgrounds: [jpeg.toString('base64')] }, jpeg, 'jpg'],
  ...['VP8 ', 'VP8L', 'VP8X'].map(signature => [signature, { backgrounds: [webp(signature).toString('base64')] }, webp(signature), 'webp']),
  ['legacy JPEG', { background: jpeg.toString('base64') }, jpeg, 'jpg'],
  ['legacy WebP', { background: webp().toString('base64') }, webp(), 'webp'],
  ['legacy base64 whitespace', { background: `${png.toString('base64').slice(0, 4)}\n${png.toString('base64').slice(4)}\n` }, png, 'png'],
]) {
  test(`background compatibility: ${label}`, async t => {
    const s = await sandbox(t);
    assert.equal((await s.install('Review', extra)).results[0].ok, true);
    const target = join(s.themes, 'review');
    assert.deepEqual((await readdir(target)).sort(), image ? ['backgrounds', 'colors.toml'] : ['colors.toml']);
    if (image) {
      assert.deepEqual(await readdir(join(target, 'backgrounds')), [`001-review.${extension}`]);
      assert.deepEqual(await readFile(join(target, 'backgrounds', `001-review.${extension}`)), image);
    }
    await s.clean();
  });
}

test('eight mixed backgrounds and three PNG assets produce exactly the permitted source tree', async t => {
  const s = await sandbox(t);
  await mkdir(join(s.icons, 'Case_Sensitive.1+Blue'));
  await writeFile(join(s.icons, 'Case_Sensitive.1+Blue/index.theme'), '[Icon Theme]\n');
  const images = [png, webp(), jpeg, webp('VP8L'), png, jpeg, webp('VP8X'), png];
  const extensions = ['png', 'webp', 'jpg', 'webp', 'png', 'jpg', 'webp', 'png'];
  const extra = {
    backgrounds: images.map(image => image.toString('base64')), mode: 'light', iconsTheme: 'Case_Sensitive.1+Blue',
    preview: png.toString('base64'), previewUnlock: png.toString('base64'), unlock: png.toString('base64'),
  };
  assert.equal((await s.install('Multi Asset', extra)).results[0].ok, true);
  const target = join(s.themes, 'multi-asset');
  assert.deepEqual((await readdir(target)).sort(), ['backgrounds', 'colors.toml', 'icons.theme', 'preview-unlock.png', 'preview.png', 'unlock.png']);
  assert.equal(await readFile(join(target, 'colors.toml'), 'utf8'), `mode = "light"\n${toml}`);
  assert.equal(await readFile(join(target, 'icons.theme'), 'utf8'), 'Case_Sensitive.1+Blue\n');
  const filenames = extensions.map((ext, index) => `${String(index + 1).padStart(3, '0')}-multi-asset.${ext}`);
  assert.deepEqual((await readdir(join(target, 'backgrounds'))).sort(), filenames);
  for (let i = 0; i < images.length; i++) assert.deepEqual(await readFile(join(target, 'backgrounds', filenames[i])), images[i]);
  for (const name of ['preview.png', 'preview-unlock.png', 'unlock.png']) assert.deepEqual(await readFile(join(target, name)), png);
  assert.equal(await readFile(join(s.root, 'setter-calls'), 'utf8'), '-f omarchy-theme-set multi-asset\n');
  await s.clean();
});

test('distinct theme slugs have disjoint background basenames in request order', async t => {
  const s = await sandbox(t);
  const images = [png, webp(), jpeg];
  const lists = [];
  for (const [name, slug] of [['Review_1.0+Blue', 'review_1.0+blue'], ['Review Red', 'review-red']]) {
    assert.equal((await s.install(name, { backgrounds: images.map(image => image.toString('base64')) })).results[0].ok, true);
    const directory = join(s.themes, slug, 'backgrounds');
    const filenames = (await readdir(directory)).sort();
    assert.deepEqual(filenames, [`001-${slug}.png`, `002-${slug}.webp`, `003-${slug}.jpg`]);
    for (let i = 0; i < images.length; i++) assert.deepEqual(await readFile(join(directory, filenames[i])), images[i]);
    lists.push(filenames);
    await s.expire();
  }
  assert.deepEqual(lists[0].filter(filename => lists[1].includes(filename)), []);
  await s.clean();
});

for (const mode of ['dark', 'light']) {
  test(`${mode} is separate flat TOML metadata, not a color or a separate file`, async t => {
    const s = await sandbox(t);
    assert.equal((await s.install('Review', { mode })).results[0].ok, true);
    assert.equal(await readFile(join(s.themes, 'review/colors.toml'), 'utf8'), `mode = "${mode}"\n${toml}`);
    assert.deepEqual(await readdir(join(s.themes, 'review')), ['colors.toml']);
    await s.clean();
  });
}

for (const [label, extra, filenames] of [
  ['preview alone', { preview: png.toString('base64') }, ['colors.toml', 'preview.png']],
  ['unlock pair alone', { previewUnlock: png.toString('base64'), unlock: png.toString('base64') }, ['colors.toml', 'preview-unlock.png', 'unlock.png']],
]) {
  test(`${label} needs no background`, async t => {
    const s = await sandbox(t);
    assert.equal((await s.install('Review', extra)).results[0].ok, true);
    assert.deepEqual((await readdir(join(s.themes, 'review'))).sort(), filenames);
    await s.clean();
  });
}

for (const field of ['preview', 'previewUnlock', 'unlock']) {
  for (const [format, image] of [['JPEG', jpeg], ['WebP', webp()]]) {
    test(`${field} refuses ${format} bytes even after staging valid images`, async t => {
      const s = await sandbox(t);
      const extra = {
        backgrounds: [png.toString('base64')], preview: png.toString('base64'),
        previewUnlock: png.toString('base64'), unlock: png.toString('base64'), [field]: image.toString('base64'),
      };
      const result = await s.install('Review', extra);
      assert.equal(result.results[0].ok, false);
      assert.match(result.results[0].error, /must be a PNG/);
      assert.deepEqual(await readdir(s.themes), []);
      assert.deepEqual(await readdir(s.records), []);
      assert.equal(await exists(join(s.root, 'setter-calls')), false);
      await s.clean();
    });
  }
}

test('default is reserved only when an unlock pair would be installed', async t => {
  const s = await sandbox(t);
  for (const name of ['default', 'DEFAULT', '<b>Default</b>']) {
    const result = await s.install(name, { previewUnlock: png.toString('base64'), unlock: png.toString('base64') });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /reserved/);
  }
  assert.equal(await exists(s.state), false);
  assert.equal((await s.install('Default', { preview: png.toString('base64') })).results[0].ok, true);
  await s.clean();
});

test('icon identifiers accept their exact ASCII boundary and trusted internal symlinks', async t => {
  const s = await sandbox(t);
  const name = `A._+-${'z'.repeat(59)}`;
  await mkdir(join(s.icons, name));
  await writeFile(join(s.icons, name, 'index.theme'), '[Icon Theme]\n');
  await symlink(join(s.icons, name), join(s.icons, 'Alias'));
  await mkdir(join(s.icons, 'IndexAlias'));
  await symlink(join(s.icons, name, 'index.theme'), join(s.icons, 'IndexAlias/index.theme'));
  for (const iconsTheme of [name, 'Alias', 'IndexAlias']) {
    assert.equal((await s.install(iconsTheme, { iconsTheme })).results[0].ok, true);
    assert.equal(await readFile(join(s.themes, iconsTheme.toLowerCase(), 'icons.theme'), 'utf8'), `${iconsTheme}\n`);
    await s.expire();
  }
  await s.clean();
});

test('icons must resolve to an installed index.theme entirely inside the system icon tree', async t => {
  const s = await sandbox(t);
  const userIcons = join(s.home, '.local/share/icons');
  await mkdir(join(userIcons, 'UserOnly'), { recursive: true });
  await writeFile(join(userIcons, 'UserOnly/index.theme'), '[Icon Theme]\n');
  await mkdir(join(s.icons, 'Adwaita'));
  await writeFile(join(s.icons, 'Adwaita/index.theme'), '[Icon Theme]\n');
  await mkdir(join(s.icons, 'MissingIndex'));
  await mkdir(join(s.icons, 'DirectoryIndex/index.theme'), { recursive: true });
  await symlink(join(userIcons, 'UserOnly'), join(s.icons, 'OutsideDirectory'));
  await mkdir(join(s.icons, 'OutsideIndex'));
  await symlink(join(userIcons, 'UserOnly/index.theme'), join(s.icons, 'OutsideIndex/index.theme'));
  await mkdir(join(s.root, 'icons-extra'));
  await writeFile(join(s.root, 'icons-extra/index.theme'), '[Icon Theme]\n');
  await symlink(join(s.root, 'icons-extra'), join(s.icons, 'PrefixEscape'));
  await symlink(join(s.root, 'missing'), join(s.icons, 'Dangling'));
  for (const iconsTheme of ['Uninstalled', 'adwaita', 'UserOnly', 'MissingIndex', 'DirectoryIndex', 'OutsideDirectory', 'OutsideIndex', 'PrefixEscape', 'Dangling']) {
    const result = await s.install('Review', { iconsTheme }, { SYSTEM_ICONS_DIR: userIcons });
    assert.equal(result.results[0].ok, false, iconsTheme);
    assert.match(result.results[0].error, /not installed/);
  }
  assert.deepEqual(await readdir(s.themes), []);
  assert.equal(await exists(s.state), false, 'installed-icon validation precedes admission');
  assert.equal(await exists(join(s.root, 'decoder-calls')), false);
  assert.equal(await exists(join(s.root, 'setter-calls')), false);
  assert.equal((await s.install('Review', { iconsTheme: 'Adwaita' })).results[0].ok, true);
  await s.clean();
});

test('malformed image signatures, WebP lengths, and later base64 failures clean partial staging', async t => {
  const s = await sandbox(t);
  const wrongRiffSize = webp();
  wrongRiffSize.writeUInt32LE(wrongRiffSize.length - 9, 4);
  const wrongChunkSize = webp();
  wrongChunkSize.writeUInt32LE(1000, 16);
  const invalid = [
    Buffer.from('not an image'), png.subarray(0, 7), Buffer.from('ffd8', 'hex'),
    webp().subarray(0, 12), webp().subarray(0, 16), webp('JUNK'), webp('VP8 ', 0), wrongRiffSize, wrongChunkSize,
    Buffer.concat([webp(), Buffer.alloc(1)]), webp('VP8L', 1).subarray(0, 21),
  ].map(image => image.toString('base64'));
  invalid.push(`${png.toString('base64')}!!`, '!!!!', ' \n', '\\c', '\\x89PNG', '$(id)', 'data:image/png;base64,' + png.toString('base64'));
  for (const background of invalid) {
    const result = await s.install('Review', { backgrounds: [png.toString('base64'), background] });
    assert.equal(result.results[0].ok, false, background);
    assert.deepEqual(await readdir(s.themes), []);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
    await s.expire();
  }
  for (const fault of ['TEST_IMAGE_MOVE_FAILURE', 'TEST_IMAGE_MOVE_SKIP']) {
    const failedMove = await s.install('Review', {
      backgrounds: [jpeg.toString('base64'), webp().toString('base64')], preview: png.toString('base64'),
    }, { [fault]: '3' });
    assert.match(failedMove.results[0].error, /cannot name/);
    assert.deepEqual(await readdir(s.themes), []);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
    await s.expire();
  }
  assert.equal(await exists(join(s.root, 'setter-calls')), false);
});

test('a failed decode in any PNG field is admitted and removes all partially staged assets', async t => {
  const s = await sandbox(t);
  for (const field of ['preview', 'previewUnlock', 'unlock']) {
    const result = await s.install('Review', {
      backgrounds: [jpeg.toString('base64'), webp().toString('base64')],
      preview: png.toString('base64'), previewUnlock: png.toString('base64'), unlock: png.toString('base64'), [field]: '!!!!',
    });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /base64/);
    assert.equal(await readFile(join(s.state, 'last-install'), 'utf8'), `${s.env.TEST_NOW}\n`);
    assert.deepEqual(await readdir(s.themes), []);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
    assert.match((await s.install('Retry')).results[0].error, /rate limited/);
    await s.expire();
  }
  assert.equal(await exists(join(s.root, 'setter-calls')), false);
});

for (const collision of ['custom', 'git', 'symlink', 'dangling', 'file', 'builtin', 'builtin-symlink', 'web']) {
  test(`refuses ${collision} collision without changing existing data`, async t => {
    const s = await sandbox(t);
    const target = join(s.themes, 'review');
    const victim = join(s.root, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'sentinel'), 'original');
    let preserved = target;
    if (collision === 'symlink' || collision === 'dangling') {
      await symlink(collision === 'symlink' ? victim : join(s.root, 'missing'), target);
    } else if (collision === 'file') {
      await writeFile(target, 'original');
    } else if (collision.startsWith('builtin')) {
      preserved = join(s.env.OMARCHY_PATH, 'themes/review');
      if (collision === 'builtin-symlink') await symlink(join(s.root, 'missing'), preserved);
      else { await mkdir(preserved); await writeFile(join(preserved, 'sentinel'), 'original'); }
    } else {
      await mkdir(target);
      await writeFile(join(target, 'sentinel'), 'original');
      if (collision === 'git') await mkdir(join(target, '.git'));
      if (collision === 'web') await writeFile(join(target, MARKER), '1\n');
    }
    const before = await lstat(preserved);
    const result = await s.install();
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /already exists/);
    assert.equal((await lstat(preserved)).ino, before.ino);
    assert.equal(await readFile(join(victim, 'sentinel'), 'utf8'), 'original');
    if (collision === 'git') assert.equal(await exists(join(target, '.git')), true);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
  });
}

for (const fault of ['fail', 'skip', 'directory', 'symlink']) {
  test(`publication ${fault} fails closed and cleans only its staging directory`, async t => {
    const s = await sandbox(t);
    await mkdir(join(s.root, 'victim'));
    await writeFile(join(s.root, 'victim/sentinel'), 'original');
    const result = await s.install('Review', {}, { TEST_PUBLICATION: fault });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /without overwriting/);
    assert.equal(await readFile(join(s.root, 'victim/sentinel'), 'utf8'), 'original');
    if (fault === 'directory') assert.deepEqual(await readdir(join(s.themes, 'review')), ['sentinel']);
    else if (fault === 'symlink') assert.equal((await lstat(join(s.themes, 'review'))).isSymbolicLink(), true);
    else assert.equal(await exists(join(s.themes, 'review')), false);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
  });
}

test('admission persists across sessions, including failed installs', async t => {
  const s = await sandbox(t);
  assert.equal((await s.install('First', { background: '!!!!' })).results[0].ok, false);
  const rejected = await s.install('Second');
  assert.match(rejected.results[0].error, /rate limited/);
  assert.equal(await exists(join(s.themes, 'second')), false);
  await s.expire();
  assert.equal((await s.install('Second')).results[0].ok, true);
  await s.clean();
});

test('persistent admission requires a two-second timestamp interval', async t => {
  const s = await sandbox(t);
  assert.equal((await s.install('First')).results[0].ok, true);
  const early = await s.install('Second', {}, { TEST_NOW: String(Number(s.env.TEST_NOW) + 1) });
  assert.match(early.results[0].error, /rate limited/);
  const admitted = await s.install('Second', {}, { TEST_NOW: String(Number(s.env.TEST_NOW) + 2) });
  assert.equal(admitted.results[0].ok, true);
  await s.clean();
});

test('timestamp publication failure prevents staging and leaves admission retryable', async t => {
  const s = await sandbox(t);
  for (const fault of ['1', 'skip']) {
    const result = await s.install('Review', {}, { TEST_TIMESTAMP_FAILURE: fault });
    assert.equal(result.results[0].ok, false);
    assert.match(result.results[0].error, /persist/);
    assert.equal(await exists(join(s.state, 'last-install')), false);
    assert.deepEqual(await readdir(s.themes), []);
    assert.deepEqual(await readdir(s.records), []);
    await s.clean();
  }
  assert.equal((await s.install()).results[0].ok, true);
});

test('admission atomically replaces its file without truncating hard links through an abandoned temporary', async t => {
  const s = await sandbox(t);
  await mkdir(s.state, { recursive: true, mode: 0o700 });
  await s.expire();
  const stamp = join(s.state, 'last-install');
  const oldStamp = join(s.root, 'old-stamp');
  await link(stamp, oldStamp);
  await link(stamp, join(s.state, '.last-install.tmp'));
  assert.match((await s.install('Review', {}, { TEST_TIMESTAMP_FAILURE: '1' })).results[0].error, /persist/);
  assert.equal(await readFile(stamp, 'utf8'), `${Number(s.env.TEST_NOW) - 3}\n`);
  assert.equal((await s.install()).results[0].ok, true);
  assert.equal(await readFile(oldStamp, 'utf8'), `${Number(s.env.TEST_NOW) - 3}\n`);
  assert.equal(await readFile(stamp, 'utf8'), `${s.env.TEST_NOW}\n`);
  assert.notEqual((await lstat(stamp)).ino, (await lstat(oldStamp)).ino);
  await s.clean();
});

test('interrupted publication cleans staging and releases the lock without forgetting admission', async t => {
  const s = await sandbox(t);
  const interrupted = await s.install('First', {}, { TEST_PUBLICATION: 'interrupt' });
  assert.equal(interrupted.results.length, 0);
  assert.deepEqual(await readdir(s.themes), []);
  assert.deepEqual(await readdir(s.records), []);
  await s.clean();
  assert.match((await s.install('Second')).results[0].error, /rate limited/);
  await s.expire();
  assert.equal((await s.install('Second')).results[0].ok, true);
});

for (const fault of ['fail', 'skip', 'fail-after', 'interrupt-after', 'competing']) {
  test(`membership reservation ${fault} never publishes and cleans only its own record`, async t => {
    const s = await sandbox(t);
    const result = await s.install('Review', {}, { TEST_RESERVATION: fault });
    if (fault === 'interrupt-after') assert.equal(result.results.length, 0);
    else {
      assert.equal(result.results[0].ok, false);
      assert.match(result.results[0].error, /reserve/);
    }
    assert.deepEqual(await readdir(s.themes), []);
    assert.deepEqual(await readdir(s.records), fault === 'competing' ? ['review'] : []);
    if (fault === 'competing') assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
    assert.equal(await exists(join(s.root, 'reserved-before-publication')), false);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    await s.clean();
    assert.match((await s.install('Second')).results[0].error, /rate limited/);
    await s.expire();
    assert.equal((await s.install('Second')).results[0].ok, true);
  });
}

for (const fault of ['symlink', 'directory']) {
  test(`a competing ${fault} membership reservation is not overwritten or removed`, async t => {
    const s = await sandbox(t);
    await writeFile(join(s.root, 'victim'), 'preserve');
    assert.match((await s.install('Review', {}, { TEST_RESERVATION: fault })).results[0].error, /reserve/);
    const record = join(s.records, 'review');
    const before = await lstat(record);
    assert.equal(fault === 'symlink' ? before.isSymbolicLink() : before.isDirectory(), true);
    assert.deepEqual(await readdir(s.themes), []);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    await s.clean();
    await s.expire();
    assert.match((await s.install('Other')).results[0].error, /membership record/);
    assert.equal((await lstat(record)).ino, before.ino);
    assert.equal(await readFile(join(s.root, 'victim'), 'utf8'), 'preserve');
    await rm(record, { recursive: true });
    assert.equal((await s.install()).results[0].ok, true);
    await s.clean();
  });
}

for (const fault of ['fail-after', 'interrupt-after', 'crash-after']) {
  test(`publication ${fault} preserves membership for the already-published theme`, async t => {
    const s = await sandbox(t);
    for (let i = 0; i < 63; i++) await markedTheme(join(s.themes, `owned-${i}`));
    const result = await s.install('Review', {}, { TEST_PUBLICATION: fault });
    if (fault === 'fail-after') assert.equal(result.results[0].ok, false);
    else assert.equal(result.results.length, 0);
    assert.deepEqual(await readdir(join(s.themes, 'review')), ['colors.toml']);
    assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
    assert.equal(await exists(join(s.root, 'reserved-before-publication')), true);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
    if (fault !== 'crash-after') await s.clean();
    await s.expire();
    assert.match((await s.install('Excess')).results[0].error, /quota/);
    await s.clean();
  });
}

for (const fault of [{ TEST_PUBLICATION: 'crash-before' }, { TEST_RESERVATION: 'crash-after' }]) {
  test(`SIGKILL at ${Object.keys(fault)[0]} leaves one counted stage and a reusable stale reservation`, async t => {
    const s = await sandbox(t);
    for (let i = 0; i < 63; i++) await markedTheme(join(s.themes, `owned-${i}`));
    assert.equal((await s.install('Review', {}, fault)).results.length, 0);
    assert.equal(await exists(join(s.themes, 'review')), false);
    assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
    const stages = (await readdir(s.themes)).filter(name => name.startsWith('.omarchy-browser-stage.'));
    assert.equal(stages.length, 1);
    assert.deepEqual(await readdir(join(s.themes, stages[0])), ['colors.toml']);
    await s.expire();
    assert.match((await s.install('Excess')).results[0].error, /quota/);
    await rm(join(s.themes, stages[0]), { recursive: true });
    await s.expire();
    assert.equal((await s.install('Review')).results[0].ok, true, 'stale record is not itself a quota slot');
    assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
    await s.clean();
  });
}

test('uncertain publication preserves its reservation without charging a missing source', async t => {
  const s = await sandbox(t);
  const result = await s.install('Review', {}, { TEST_PUBLICATION: 'uncertain' });
  assert.equal(result.results[0].ok, false);
  assert.equal(await exists(join(s.themes, 'review')), false);
  assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
  await s.clean();
  await s.expire();
  assert.equal((await s.install('Review')).results[0].ok, true);
  await s.clean();
});

test('abandoned record temporary hard links are removed rather than truncating existing membership', async t => {
  const s = await sandbox(t);
  assert.equal((await s.install('First', {}, { TEST_PUBLICATION: 'crash-after' })).results.length, 0);
  const record = join(s.records, 'first');
  assert.equal((await lstat(record)).nlink, 2);
  await s.expire();
  assert.equal((await s.install('Second')).results[0].ok, true);
  assert.equal((await lstat(record)).nlink, 1);
  assert.notEqual((await lstat(record)).ino, (await lstat(join(s.records, 'second'))).ino);
  assert.equal(await readFile(record, 'utf8'), '1\n');
  await s.clean();
});

test('a pre-existing stale reservation is never removed on a failed publication', async t => {
  const s = await sandbox(t);
  await membership(s, 'review');
  const before = await lstat(join(s.records, 'review'));
  assert.equal((await s.install('Review', {}, { TEST_PUBLICATION: 'fail' })).results[0].ok, false);
  assert.equal((await lstat(join(s.records, 'review'))).ino, before.ino);
  assert.equal(await readFile(join(s.records, 'review'), 'utf8'), '1\n');
  await s.clean();
});

test('cross-host lock rejects a competing admission before staging', async t => {
  const s = await sandbox(t);
  const first = s.install('First', {}, { TEST_PUBLICATION: 'hold' });
  for (let attempt = 0; !await exists(join(s.root, 'publishing')); attempt++) {
    assert.ok(attempt < 300, 'first host reached publication');
    await delay(10);
  }
  const second = await s.install('Second');
  assert.match(second.results[0].error, /busy/);
  assert.equal((await first).results[0].ok, true);
  assert.deepEqual(await readdir(s.themes), ['first']);
  await s.clean();
});

for (const kind of ['legacy', 'external', 'both', 'mixed']) {
  test(`${kind} membership counts its union once, ignores unrelated themes, and permits exactly 64 themes`, async t => {
    const s = await sandbox(t);
    for (let i = 0; i < 63; i++) {
      const legacy = kind === 'legacy' || kind === 'both' || (kind === 'mixed' && i % 3 !== 1);
      const external = kind === 'external' || kind === 'both' || (kind === 'mixed' && i % 3 !== 0);
      if (legacy) await markedTheme(join(s.themes, `owned-${i}`));
      else {
        await mkdir(join(s.themes, `owned-${i}`));
        await writeFile(join(s.themes, `owned-${i}`, 'colors.toml'), toml);
      }
      if (external) await membership(s, `owned-${i}`);
    }
    await mkdir(join(s.themes, 'unrelated/.git'), { recursive: true });
    await sparse(join(s.themes, 'unrelated/large'), QUOTA + 1);
    assert.equal((await s.install('Last')).results[0].ok, true);
    await s.expire();
    const rejected = await s.install('Excess');
    assert.match(rejected.results[0].error, /quota/);
    assert.equal(await exists(join(s.themes, 'excess')), false);
    await rm(join(s.themes, 'owned-0'), { recursive: true });
    await s.expire();
    assert.equal((await s.install('Excess')).results[0].ok, true, 'removing a source frees quota even with a stale record');
    if (kind === 'legacy' || kind === 'both') assert.equal(await readFile(join(s.themes, 'owned-1', MARKER), 'utf8'), '1\n');
    await s.clean();
  });
}

test('valid stale records and source symlinks do not consume theme or byte quota', async t => {
  const s = await sandbox(t);
  for (let i = 0; i < 65; i++) await membership(s, `stale-${i}`);
  await mkdir(join(s.root, 'outside'));
  await sparse(join(s.root, 'outside/large'), QUOTA + 1);
  await symlink(join(s.root, 'outside'), join(s.themes, 'stale-0'));
  await symlink(join(s.root, 'missing'), join(s.themes, 'stale-1'));
  await writeFile(join(s.themes, 'stale-2'), 'not a source directory');
  assert.equal((await s.install('Review')).results[0].ok, true);
  assert.equal((await readdir(s.records)).length, 66);
  assert.equal((await lstat(join(s.root, 'outside/large'))).size, QUOTA + 1);
  await s.clean();
});

test('abandoned staging directories remain charged to quota', async t => {
  const s = await sandbox(t);
  for (let i = 0; i < 63; i++) await markedTheme(join(s.themes, `owned-${i}`));
  const abandoned = join(s.themes, '.omarchy-browser-stage.abandoned0');
  await mkdir(abandoned);
  await writeFile(join(abandoned, 'partial'), 'interrupted install');
  assert.match((await s.install()).results[0].error, /quota/);
  assert.equal(await readFile(join(abandoned, 'partial'), 'utf8'), 'interrupted install');
  assert.equal(await exists(join(s.themes, 'review')), false);
});

test('abandoned stages with legacy markers count once alongside the old/new union', async t => {
  const s = await sandbox(t);
  for (let i = 0; i < 62; i++) {
    await markedTheme(join(s.themes, `owned-${i}`));
    await membership(s, `owned-${i}`);
  }
  const abandoned = join(s.themes, '.omarchy-browser-stage.abandoned0');
  await markedTheme(abandoned);
  assert.equal((await s.install('Last')).results[0].ok, true);
  await s.expire();
  assert.match((await s.install('Excess')).results[0].error, /quota/);
  assert.equal(await readFile(join(abandoned, MARKER), 'utf8'), '1\n');
  await rm(abandoned, { recursive: true });
  await s.clean();
});

for (const [kind, excess] of ['legacy', 'external', 'both'].flatMap(kind => [0, 1].map(excess => [kind, excess]))) {
  test(`${kind} aggregate apparent-byte quota ${excess ? 'rejects one byte over' : 'permits exactly'} 256 MiB`, async t => {
    const s = await sandbox(t);
    const existing = join(s.themes, 'owned');
    const sample = join(s.root, 'sample');
    if (kind !== 'external') await markedTheme(existing);
    else {
      await mkdir(existing);
      await writeFile(join(existing, 'colors.toml'), toml);
    }
    if (kind !== 'legacy') await membership(s, 'owned');
    await mkdir(sample);
    await writeFile(join(sample, 'colors.toml'), toml);
    await sparse(join(existing, 'padding'), 0);
    await sparse(join(existing, 'padding'), QUOTA - usage(sample) - usage(existing) + excess);
    const result = await s.install();
    assert.equal(result.results[0].ok, excess === 0);
    if (excess) {
      assert.match(result.results[0].error, /quota/);
      assert.equal(await exists(join(s.themes, 'review')), false);
    } else assert.equal(usage(existing) + usage(join(s.themes, 'review')), QUOTA);
    await s.clean();
  });
}

test('quota measurement errors and malformed markers fail closed', async t => {
  const s = await sandbox(t);
  await markedTheme(join(s.themes, 'owned'));
  assert.match((await s.install('First', {}, { TEST_QUOTA_FAILURE: '1' })).results[0].error, /measure/);
  await s.expire();
  await membership(s, 'owned');
  await writeFile(join(s.themes, 'owned', MARKER), 'bogus');
  assert.match((await s.install('Second')).results[0].error, /marker/);
  await s.clean();
});

test('quota errors measuring new multi-asset staging leave no publication or membership', async t => {
  const s = await sandbox(t);
  const result = await s.install('Review', {
    backgrounds: [png.toString('base64'), webp().toString('base64')], preview: png.toString('base64'),
  }, { TEST_QUOTA_FAILURE: '1' });
  assert.match(result.results[0].error, /measure/);
  assert.equal((await readFile(join(s.root, 'decoder-calls'), 'utf8')).split('\n').filter(Boolean).length, 3);
  assert.deepEqual(await readdir(s.themes), []);
  assert.deepEqual(await readdir(s.records), []);
  assert.equal(await exists(join(s.root, 'setter-calls')), false);
  await s.clean();
});

for (const kind of ['symlink', 'dangling', 'file', 'permissions']) {
  test(`unsafe membership directory fails closed before admission: ${kind}`, async t => {
    const s = await sandbox(t);
    await mkdir(s.state, { recursive: true, mode: 0o700 });
    await mkdir(join(s.root, 'victim'));
    await writeFile(join(s.root, 'victim/sentinel'), 'preserve');
    if (kind === 'symlink' || kind === 'dangling') {
      await symlink(join(s.root, kind === 'symlink' ? 'victim' : 'missing'), s.records);
    } else if (kind === 'file') await writeFile(s.records, 'preserve');
    else await mkdir(s.records, { mode: 0o755 });
    const before = await lstat(s.records);
    assert.match((await s.install()).results[0].error, /membership directory/);
    assert.equal((await lstat(s.records)).ino, before.ino);
    assert.equal((await lstat(s.records)).mode, before.mode);
    assert.equal(await exists(join(s.state, 'last-install')), false);
    assert.deepEqual(await readdir(s.themes), []);
    assert.equal(await readFile(join(s.root, 'victim/sentinel'), 'utf8'), 'preserve');
    if (kind === 'file') assert.equal(await readFile(s.records, 'utf8'), 'preserve');
    await s.clean();
  });
}

test('membership records require exactly version 1 even when their source directory is missing', async t => {
  const s = await sandbox(t);
  const record = join(s.records, 'owned');
  for (const active of [false, true]) {
    if (active) await markedTheme(join(s.themes, 'owned'));
    for (const value of ['', '1', '1\n\n', '1\u0000', '1\r', '1\r\n', '2\n', '01\n', '$(id)\n', '1\n' + 'x'.repeat(65536)]) {
      await membership(s, 'owned', value);
      assert.match((await s.install()).results[0].error, /membership record/);
      assert.equal(await readFile(record, 'utf8'), value);
      assert.equal(await exists(join(s.state, 'last-install')), false);
      assert.equal(await exists(join(s.themes, 'review')), false);
    }
  }
  await membership(s, 'owned');
  assert.equal((await s.install()).results[0].ok, true);
  await s.clean();
});

test('unsafe membership record names and types are never followed, repaired, or removed', async t => {
  const s = await sandbox(t);
  for (const slug of ['.hidden', '-option', 'Uppercase', 'has space', 'control\n', 'a'.repeat(65)]) {
    await membership(s, slug);
    assert.match((await s.install()).results[0].error, /membership record/);
    assert.equal(await readFile(join(s.records, slug), 'utf8'), '1\n');
    await rm(join(s.records, slug));
  }
  const record = join(s.records, 'owned');
  await writeFile(join(s.root, 'victim'), '1\n');
  for (const kind of ['symlink', 'dangling', 'directory']) {
    if (kind === 'directory') await mkdir(record);
    else await symlink(join(s.root, kind === 'symlink' ? 'victim' : 'missing'), record);
    const before = await lstat(record);
    assert.match((await s.install()).results[0].error, /membership record/);
    assert.equal((await lstat(record)).ino, before.ino);
    assert.equal(await readFile(join(s.root, 'victim'), 'utf8'), '1\n');
    await rm(record, { recursive: true });
  }
  assert.equal(await exists(join(s.state, 'last-install')), false);
  assert.deepEqual(await readdir(s.themes), []);
  assert.equal((await s.install()).results[0].ok, true);
  await s.clean();
});

test('a symlinked record temporary fails closed without touching its target', async t => {
  const s = await sandbox(t);
  await mkdir(s.state, { recursive: true, mode: 0o700 });
  await writeFile(join(s.root, 'victim'), 'preserve');
  await symlink(join(s.root, 'victim'), join(s.state, '.theme-record.tmp'));
  assert.match((await s.install()).results[0].error, /unsafe install state file/);
  assert.equal(await exists(join(s.state, 'last-install')), false);
  assert.deepEqual(await readdir(s.themes), []);
  assert.equal(await readFile(join(s.root, 'victim'), 'utf8'), 'preserve');
  assert.equal((await lstat(join(s.state, '.theme-record.tmp'))).isSymbolicLink(), true);
});

for (const state of ['malformed', 'future', 'symlink', 'permissions']) {
  test(`rejects unsafe persisted admission state: ${state}`, async t => {
    const s = await sandbox(t);
    await mkdir(s.state, { recursive: true, mode: 0o700 });
    if (state === 'permissions') await chmod(s.state, 0o755);
    else if (state === 'symlink') {
      await writeFile(join(s.root, 'victim'), 'preserve');
      await symlink(join(s.root, 'victim'), join(s.state, 'install.lock'));
    } else {
      await writeFile(join(s.state, 'last-install'), state === 'future' ? '999999999999\n' : '$(id)\n');
    }
    assert.equal((await s.install()).results[0].ok, false);
    assert.deepEqual(await readdir(s.themes), []);
    if (state === 'symlink') assert.equal(await readFile(join(s.root, 'victim'), 'utf8'), 'preserve');
  });
}

test('strict schema rejects malformed colors, controls, extra fields, and oversized names/palettes', async t => {
  const s = await sandbox(t);
  const many = { ...colors };
  for (let i = 0; i < 126; i++) many[`extra${i}`] = '#123456';
  const invalid = [
    { name: 'a'.repeat(65) }, { name: 'Review\n' }, { name: 'Re\u0000view' }, { name: 3 },
    { colors: many }, { colors: [] }, { colors: null }, { colors: { background: '#112233' } },
    { colors: { ...colors, accent: '#123456\n' } },
    { colors: { ...colors, extra: 7 } }, { colors: { ...colors, extra: '#fff' } },
    { colors: { ...colors, 'extra\n': '#123456' } },
    { colors: { ...colors, ['x'.repeat(33)]: '#123456' } },
    { colors: { ...colors, mode: '#123456' } }, { colors: { ...colors, mode: 'dark' } },
    { background: null }, { background: 'AA\u0000==' }, { id: 'x'.repeat(65) }, { unexpected: true },
    { backgrounds: null }, { backgrounds: png.toString('base64') }, { backgrounds: {} },
    { backgrounds: [''] }, { backgrounds: [null] }, { backgrounds: [1] }, { backgrounds: ['AA\u0000=='] },
    { backgrounds: Array(9).fill(png.toString('base64')) },
    ...['', png.toString('base64')].flatMap(background => [[], [png.toString('base64')]].map(backgrounds => ({ background, backgrounds }))),
    ...['preview', 'previewUnlock', 'unlock'].flatMap(field => ['', null, 3, 'AA\u0000=='].map(value => ({
      previewUnlock: png.toString('base64'), unlock: png.toString('base64'), [field]: value,
    }))),
    { previewUnlock: png.toString('base64') }, { unlock: png.toString('base64') },
    ...[null, '', 'Dark', 'LIGHT', 'light\n', 'light"\n[bad]', 1].map(mode => ({ mode })),
    ...[null, '', 1, 'a'.repeat(65), 'Adwaita\n', 'Adwaita\u0000', '../Adwaita', '/usr/share/icons/Adwaita',
      'Adwaita/index.theme', 'foo\\bar', 'foo bar', '$(id)', 'foo;id', '-foo', '.foo', '_foo', 'Ic\u00f4ns'].map(iconsTheme => ({ iconsTheme })),
    { files: { 'hyprland.lua': 'os.execute("id")' } }, { path: '../escape' }, { iconsPath: '/tmp/icons' },
    { 'preview.png': png.toString('base64') }, { backgrounds: [{ name: '../escape', data: png.toString('base64') }] },
    ...['colorsToml', 'colors.toml', 'hyprland.lua', 'lua', 'archive', 'url', 'filename', 'icons.theme', 'SYSTEM_ICONS_DIR', MARKER]
      .map(field => ({ [field]: 'untrusted content' })),
  ];
  const input = Buffer.concat(invalid.map(extra => frame({ type: 'install-theme', id: 'invalid', name: 'Review', colors, ...extra })));
  const result = await s.run(input);
  assert.equal(result.results.length, invalid.length);
  assert.ok(result.results.every(reply => !reply.ok && /schema/.test(reply.error)));
  assert.deepEqual(await readdir(s.themes), []);
  assert.equal(await exists(s.state), false, 'schema failures precede admission writes');
  assert.equal(await exists(join(s.root, 'decoder-calls')), false);
});

test('exact name, color-count, and key-length boundaries are accepted', async t => {
  const s = await sandbox(t);
  const palette = { ...colors, ['x'.repeat(32)]: '#ABCDEF' };
  for (let i = 0; i < 124; i++) palette[`extra${i}`] = '#123456';
  assert.equal((await s.install('a'.repeat(64), { colors: palette })).results[0].ok, true);
  await s.clean();
});

test('set rejects unknown or unsafe names and keeps its per-port apply limit', async t => {
  const s = await sandbox(t);
  await mkdir(join(s.env.OMARCHY_PATH, 'themes/example'));
  const names = ['../escape', 'example;id', 'missing', 'Example', 'Example'];
  const result = await s.run(Buffer.concat(names.map((name, i) => frame({ type: 'set-theme', id: String(i), name }))));
  assert.deepEqual(result.results.map(reply => reply.ok), [false, false, false, true, false]);
  assert.match(result.results.at(-1).error, /rate limited/);
});

test('installation also updates the existing per-port apply limit', async t => {
  const s = await sandbox(t);
  const result = await s.run(Buffer.concat([
    frame({ type: 'install-theme', id: 'install', name: 'Review', colors }),
    frame({ type: 'set-theme', id: 'set', name: 'Review' }),
  ]));
  assert.equal(result.results[0].ok, true);
  assert.equal(result.results[1].ok, false);
  assert.match(result.results[1].error, /rate limited/);
});

test('8 MiB image fits the native cap; one extra decoded byte is refused and cleaned', async t => {
  const s = await sandbox(t);
  const image = Buffer.alloc(IMAGE_LIMIT);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(image);
  const accepted = await s.install('Image', { background: image.toString('base64') });
  assert.equal(accepted.results[0].ok, true);
  assert.equal((await lstat(join(s.themes, 'image/backgrounds/001-image.png'))).size, image.length);
  await s.expire();
  const rejected = await s.install('Oversized', { background: Buffer.concat([image, Buffer.alloc(1)]).toString('base64') });
  assert.equal(rejected.results[0].ok, false);
  assert.match(rejected.results[0].error, /larger than/);
  assert.equal(await exists(join(s.themes, 'oversized')), false);
  await s.clean();
});

test('eleven padded images meet the exact encoded, decoded, and 12 MiB frame boundaries', async t => {
  const s = await sandbox(t);
  // Each image is 1 mod 3 bytes, maximizing separate base64 padding overhead.
  const partSize = Math.floor(IMAGE_LIMIT / 11 / 3) * 3 + 1;
  for (const excess of [0, 1]) {
    const images = Array.from({ length: 11 }, (_, i) => {
      const image = Buffer.alloc(i < 10 ? partSize : IMAGE_LIMIT - partSize * 10 + excess);
      png.copy(image);
      return image;
    });
    const encoded = images.map(image => image.toString('base64'));
    const encodedLength = encoded.reduce((sum, value) => sum + value.length, 0);
    assert.equal(encodedLength, ENCODED_LIMIT - 4, 'separate padding exceeds the old single-image encoded cap');
    const extra = {
      backgrounds: encoded.slice(0, 8), preview: encoded[8], previewUnlock: encoded[9], unlock: encoded[10],
    };
    let result;
    if (!excess) {
      extra.backgrounds[0] += '\n'.repeat(ENCODED_LIMIT - encodedLength + 1);
      const rejected = await s.install('Encoded Overflow', extra);
      assert.match(rejected.results[0].error, /schema/);
      assert.equal(await exists(s.state), false);
      assert.equal(await exists(join(s.root, 'decoder-calls')), false);

      extra.backgrounds[0] = encoded[0] + '\n'.repeat(ENCODED_LIMIT - encodedLength);
      const body = Buffer.from(JSON.stringify({ type: 'install-theme', id: 'install', name: 'Budget', colors, ...extra }));
      assert.ok(body.length < FRAME_LIMIT);
      result = await s.run(frame(Buffer.concat([body, Buffer.alloc(FRAME_LIMIT - body.length, 0x20)])));
      assert.equal(result.results[0].ok, true);
      const files = [...Array.from({ length: 8 }, (_, i) => `backgrounds/00${i + 1}-budget.png`), 'preview.png', 'preview-unlock.png', 'unlock.png'];
      for (let i = 0; i < files.length; i++) {
        assert.equal((await lstat(join(s.themes, 'budget', files[i]))).size, images[i].length);
      }
    } else {
      result = await s.install('Over Budget', extra);
      assert.equal(result.results[0].ok, false);
      assert.match(result.results[0].error, /larger than 8 MiB/);
      assert.equal(await exists(join(s.themes, 'over-budget')), false);
    }
    assert.equal((await readFile(join(s.root, 'decoder-calls'), 'utf8')).split('\n').filter(Boolean).length, 11 * (excess + 1));
    assert.deepEqual(await readdir(s.records), ['budget']);
    await s.clean();
    await s.expire();
  }
});

test('aggregate decoded overflow stops at the offending background before later PNG assets', async t => {
  const s = await sandbox(t);
  const image = Buffer.alloc(IMAGE_LIMIT);
  png.copy(image);
  const result = await s.install('Review', {
    backgrounds: [image.toString('base64'), png.toString('base64')], preview: png.toString('base64'),
  });
  assert.equal(result.results[0].ok, false);
  assert.match(result.results[0].error, /larger than 8 MiB/);
  assert.equal((await readFile(join(s.root, 'decoder-calls'), 'utf8')).split('\n').filter(Boolean).length, 2);
  assert.deepEqual(await readdir(s.themes), []);
  assert.deepEqual(await readdir(s.records), []);
  assert.equal(await exists(join(s.root, 'setter-calls')), false);
  await s.clean();
  assert.match((await s.install('Retry')).results[0].error, /rate limited/);
});

test('native framing refuses oversized, partial, NUL-containing, and malformed JSON frames before dispatch', async t => {
  const s = await sandbox(t);
  await mkdir(join(s.env.OMARCHY_PATH, 'themes/example'));
  const request = Buffer.from(JSON.stringify({ type: 'set-theme', id: 'frame', name: 'Example' }));
  for (const input of [
    Buffer.from([1, 0, 0]), frame(Buffer.alloc(0), 0), frame(Buffer.alloc(0), FRAME_LIMIT + 1),
    frame(Buffer.alloc(0), 0xffffffff), frame(request, request.length + 10),
    frame(Buffer.concat([request, Buffer.from('garbage')])), frame(Buffer.concat([request, request])),
    frame(Buffer.concat([request, Buffer.from([0])])), frame(Buffer.from('[]')),
  ]) {
    const result = await s.run(input);
    assert.equal(result.results.length, 0);
    assert.equal(await exists(join(s.root, 'setter-calls')), false);
  }
  const padded = Buffer.concat([request, Buffer.alloc(FRAME_LIMIT - request.length, 0x20)]);
  assert.equal((await s.run(frame(padded))).results[0].ok, true);
});

test('palette output is bounded, uses stdin rather than a large argv, and supports resync', async t => {
  const s = await sandbox(t);
  const theme = join(s.current, 'theme');
  await mkdir(theme);
  await writeFile(join(s.current, 'theme.name'), 'T\u00f8ky\u00f8');
  // ASCII JSON escaping expands this below-cap source past Linux MAX_ARG_STRLEN.
  await writeFile(join(theme, 'colors.toml'), `background = "${'\x01'.repeat(30000)}"\n`);
  const result = await s.run(Buffer.concat([frame({}), frame({ type: 'get-palette' })]));
  assert.equal(result.messages.length, 3);
  assert.ok(result.messages.every(message => message.colors.background.length === 30000 && message.name === 'T\u00f8ky\u00f8'));
  await writeFile(join(theme, 'colors.toml'), 'x'.repeat(65537));
  await writeFile(join(s.current, 'theme.name'), 'n'.repeat(200000));
  const oversized = await s.run();
  assert.deepEqual(oversized.messages[0].colors, {});
  assert.equal(oversized.messages[0].name.length, 64);
  assert.equal(oversized.stderr, '');
});
