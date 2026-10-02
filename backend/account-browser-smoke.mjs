import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const {chromium} = await import(process.env.SAI_PLAYWRIGHT_MODULE || 'playwright');
const scratch = await mkdtemp(join(tmpdir(), 'sai-account-browser-'));
const probe = createServer();
await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);});
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['backend/local.mjs'], {
  env: {
    ...process.env, SAI_PORT: String(port), SAI_DB_PATH: join(scratch, 'app.sqlite'), SAI_DEMO_DIR: join(scratch, 'demo'),
    GEMINI_API_KEY: '', OPENAI_API_KEY: '', BRIGHTDATA_API_KEY: '', YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = `http://127.0.0.1:${port}`;
const serverErrors = [];
server.stderr.on('data', value => serverErrors.push(String(value)));
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    server.stdout.once('data', () => {clearTimeout(timer); resolve();});
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited ${code}: ${serverErrors.join('')}`)));
  });
  async function call(body, token = '', expected = 200) {
    const response = await fetch(origin + '/api/app', {
      method: body ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  const password = 'account-boundary-test-password';
  const accountA = await call({action: 'register', username: 'boundary_a', password, confirmPassword: password});
  await call({action: 'saveProfile', version: null, name: '계정 A', interests: []}, accountA.token);
  await call({action: 'register', username: 'boundary_b', password, confirmPassword: password, linkedinHandle: 'boundary-b'});

  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 900}});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  async function login(username) {
    await page.getByLabel('아이디', {exact: true}).fill(username);
    await page.getByLabel('비밀번호', {exact: true}).fill(password);
    await page.getByText('로그인하기', {exact: true}).click();
  }
  async function openMy() {
    await page.getByRole('tab', {name: '마이', exact: true}).click();
    await page.getByText('나를 알아가는 사이', {exact: true}).waitFor();
  }
  async function openLinkedInText() {
    await openMy();
    await page.getByText('LinkedIn', {exact: true}).click();
    await page.getByText('프로필 텍스트 직접 입력', {exact: true}).click();
    await page.getByLabel('LinkedIn 가져오기 텍스트').waitFor();
  }
  async function refresh() {
    const response = page.waitForResponse(r => r.url().endsWith('/api/app') && r.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
  }
  async function save(expected = 200) {
    const response = page.waitForResponse(r => r.url().endsWith('/api/app') && r.request().method() === 'POST' && r.request().postDataJSON()?.action === 'saveProfile');
    await page.getByText('내 취향 저장', {exact: true}).click();
    assert.equal((await response).status(), expected);
  }

  await page.goto(origin);
  await page.getByText('대화의 시작을 찾는 사이', {exact: true}).waitFor();
  await login('boundary_a');
  await page.getByText('우리 사이, 어떤 이야기?', {exact: true}).waitFor();
  await openLinkedInText();
  await page.getByLabel('LinkedIn 가져오기 텍스트').fill('A 계정의 비공개 경력 원문');
  await openMy();
  await page.getByLabel('프로필 수정').click();
  await page.getByLabel('취향 정리 문장').fill('Skills:\n비공개검증취향');
  await page.getByText('LinkedIn 목록 미리보기', {exact: true}).click();
  await page.getByText('비공개검증취향', {exact: true}).waitFor();
  await openMy();
  await page.getByText('로그아웃', {exact: true}).click();
  await page.getByText('대화의 시작을 찾는 사이', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('sai-session')), null);
  await login('boundary_b');
  await page.getByLabel('프로필 이름').waitFor();
  assert.equal(await page.getByLabel('프로필 이름').inputValue(), '');
  assert.equal(await page.getByLabel('취향 정리 문장').inputValue(), '');
  assert.equal(await page.getByText('비공개검증취향', {exact: true}).count(), 0);
  assert.equal(await page.getByLabel('LinkedIn 프로필 아이디').inputValue(), 'boundary-b');
  await page.getByLabel('프로필 이름').fill('계정 B');
  await save();
  await page.getByText('나를 알아가는 사이', {exact: true}).waitFor();
  const tokenB = await page.evaluate(() => localStorage.getItem('sai-session'));
  await openLinkedInText();
  assert.equal(await page.getByLabel('LinkedIn 가져오기 텍스트').inputValue(), '');
  console.log('PASS browser logout → other-account onboarding clears private text/candidates and preserves signup defaults');

  await openMy();
  await page.getByLabel('프로필 수정').click();
  await page.getByLabel('한 줄 소개').fill('아직 저장하지 않은 편집 내용');
  const previous = (await call(undefined, tokenB)).me;
  const latestInterests = [...previous.interests, {id: 'new-private', label: '새로 가져온 관심사', category: '공부·일', shared: false}];
  await call({action: 'saveProfile', ...previous, bio: '다른 화면에서 저장한 소개', interests: latestInterests}, tokenB);
  await refresh();
  assert.equal(await page.getByLabel('한 줄 소개').inputValue(), '아직 저장하지 않은 편집 내용');
  await save(409);
  await page.getByText('최신 프로필과 편집 내용이 달라요', {exact: true}).waitFor();
  assert.equal(await page.getByLabel('한 줄 소개').inputValue(), '아직 저장하지 않은 편집 내용');
  const preserved = (await call(undefined, tokenB)).me;
  assert.equal(preserved.bio, '다른 화면에서 저장한 소개');
  assert(preserved.interests.some(item => item.id === 'new-private' && !item.shared));
  await page.getByText('최신 프로필 불러오기', {exact: true}).click();
  assert.equal(await page.getByLabel('한 줄 소개').inputValue(), '다른 화면에서 저장한 소개');
  await page.getByText('새로 가져온 관심사', {exact: true}).waitFor();
  await page.getByLabel('한 줄 소개').fill('최신본 확인 후 저장한 소개');
  await save();
  await page.getByText('나를 알아가는 사이', {exact: true}).waitFor();
  assert.equal((await call(undefined, tokenB)).me.bio, '최신본 확인 후 저장한 소개');
  console.log('PASS browser stale editor gets 409, preserves local edits/server interests, and explicitly reloads before saving');

  await openLinkedInText();
  await page.getByLabel('LinkedIn 가져오기 텍스트').fill('B 계정의 세션 만료 전 비공개 원문');
  await call({action: 'logout'}, tokenB);
  await refresh();
  await page.getByText('세션이 만료되었어요. 다시 로그인해주세요.', {exact: true}).waitFor();
  await login('boundary_a');
  await page.getByText('우리 사이, 어떤 이야기?', {exact: true}).waitFor();
  await openLinkedInText();
  assert.equal(await page.getByLabel('LinkedIn 가져오기 텍스트').inputValue(), '');
  console.log('PASS browser session expiry clears another account’s private LinkedIn input');

  await openMy();
  await page.getByLabel('프로필 수정').click();
  await page.getByLabel('취향 정리 문장').fill('Skills:\n만료전비공개취향');
  const tokenA = await page.evaluate(() => localStorage.getItem('sai-session'));
  await call({action: 'logout'}, tokenA);
  await page.getByText('LinkedIn 목록 미리보기', {exact: true}).click();
  await page.getByText('세션이 만료되었어요. 다시 로그인해주세요.', {exact: true}).waitFor();
  await login('boundary_b');
  await page.getByText('우리 사이, 어떤 이야기?', {exact: true}).waitFor();
  await openMy();
  await page.getByLabel('프로필 수정').click();
  assert.equal(await page.getByLabel('취향 정리 문장').inputValue(), '');
  assert.equal(await page.getByText('만료전비공개취향', {exact: true}).count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log('PASS browser action 401 clears private draft input without runtime errors');
} catch (error) {
  console.error(serverErrors.join(''));
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
