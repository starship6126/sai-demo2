import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

const {chromium} = await import(process.env.SAI_PLAYWRIGHT_MODULE || 'playwright');
const scratch = await mkdtemp(join(tmpdir(), 'sai-youtube-browser-'));
const probe = createServer();
await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);});
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['backend/local.mjs'], {
  env: {...process.env, SAI_PORT: String(port), SAI_DB_PATH: join(scratch, 'app.sqlite'), SAI_DEMO_DIR: join(scratch, 'demo')},
  stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = `http://127.0.0.1:${port}`;
const channels = ['재즈 채널', '여행 채널', '요리 채널', '게임 채널', '개발 채널', '운동 채널'].map((title, index) => ({
  id: `channel-${index + 1}`, title, description: `${title}의 영상과 이야기`, url: `https://www.youtube.com/channel/channel-${index + 1}`,
}));
const longKeyword = '긴채널이름'.repeat(10) + ' 채널 시청';
// API fixtures isolate UI selection/retry behavior; youtube-import-smoke covers real persistence and fallback.
const state = {
  account: {username: 'youtube_user'},
  me: {id: 'me', name: '나의 취향', bio: '', color: '#18181B', interests: []},
  friends: [], requests: [], sent: [], rooms: [], selectedRoom: null,
  sources: {
    youtube: {status: 'ok', itemCount: 6, candidateCount: 0, updated: null, summary: null, samples: [], counts: {subscriptions: 6}, channels},
    linkedin: {status: 'never', itemCount: 0, candidateCount: 0, samples: [], counts: {}},
  },
};
let browser, completeExtraction;
let extractionCalls = 0;
const serverErrors = [], pageErrors = [];
server.stderr.on('data', value => serverErrors.push(String(value)));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    server.stdout.once('data', () => {clearTimeout(timer); resolve();});
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited ${code}: ${serverErrors.join('')}`)));
  });
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 900}});
  await context.addInitScript(() => localStorage.setItem('sai-session', 'youtube-ui-fixture'));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/api/app*', async route => {
    const request = route.request();
    assert.equal(request.headers().authorization, 'Bearer youtube-ui-fixture');
    if (request.method() === 'GET') return route.fulfill({json: state});
    const body = request.postDataJSON();
    assert.equal(body.action, 'extractYouTubeInterests');
    assert.deepEqual(body.channelIds, channels.slice(0, extractionCalls < 2 ? 5 : 1).map(channel => channel.id));
    extractionCalls++;
    if (extractionCalls === 1) return route.fulfill({status: 503, json: {error: 'Gemini 요청을 다시 시도해주세요.'}});
    if (extractionCalls === 2) {
      await new Promise(resolve => {completeExtraction = resolve;});
      state.me.interests.push({id: 'inferred-jazz', label: '재즈 감상', category: '음악', shared: false, preference: 'like', source: {kind: 'youtube', label: '재즈 채널', detail: '선택한 구독 채널을 바탕으로 추출한 관심사'}});
      state.sources.youtube.candidateCount = 1;
    }
    if (extractionCalls === 4) {
      state.me.interests.push({id: 'channel-fallback', label: longKeyword, category: '콘텐츠', shared: false, preference: 'like', source: {kind: 'youtube', label: longKeyword, detail: '선택한 채널 이름'}});
      return route.fulfill({json: {count: 1, labels: [longKeyword], fallback: true, interests: state.me.interests, summary: '선택한 채널 이름에서 키워드 1개를 비공개로 저장했어요.'}});
    }
    return route.fulfill({json: {count: extractionCalls === 2 ? 1 : 0, labels: ['재즈 감상'], fallback: false, interests: state.me.interests, summary: extractionCalls === 2 ? '관심사 1개를 비공개로 등록했어요.' : '기존 관심사에 있는 키워드를 확인했어요.'}});
  });
  await page.goto(origin);
  await page.getByRole('tab', {name: '마이', exact: true}).click();
  await page.getByText('YouTube', {exact: true}).click();
  const extract = () => page.getByRole('button', {name: '선택한 채널에서 키워드 만들기', exact: true});
  await page.getByText('0/5개 선택', {exact: true}).waitFor();
  assert.equal(state.me.interests.length, 0);
  assert(await extract().isDisabled());
  await page.getByRole('checkbox', {name: channels[0].title, exact: true}).click();
  assert(!(await extract().isDisabled()), 'one channel enables keyword creation');
  for (const channel of channels.slice(1, 4)) await page.getByRole('checkbox', {name: channel.title, exact: true}).click();
  assert(!(await extract().isDisabled()));
  await page.getByRole('checkbox', {name: channels[4].title, exact: true}).click();
  await page.getByText('5/5개 선택', {exact: true}).waitFor();
  assert.equal(await page.getByRole('checkbox', {checked: true}).count(), 5);
  assert(await page.getByRole('checkbox', {name: channels[5].title, exact: true}).isDisabled());
  assert(!(await extract().isDisabled()));
  // Deselecting releases the maximum and analysis remains available for four channels.
  await page.getByRole('checkbox', {name: channels[4].title, exact: true}).click();
  assert(!(await page.getByRole('checkbox', {name: channels[5].title, exact: true}).isDisabled()));
  assert(!(await extract().isDisabled()));
  await page.getByRole('checkbox', {name: channels[4].title, exact: true}).click();
  await mkdir('.data/qa', {recursive: true});
  await page.screenshot({path: '.data/qa/youtube-selection-mobile.png', fullPage: true});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: '.data/qa/youtube-selection-desktop.png', fullPage: true});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await extract().click();
  await page.getByText('Gemini 요청을 다시 시도해주세요.', {exact: true}).waitFor();
  assert.equal(state.me.interests.length, 0);
  assert.equal(await page.getByRole('checkbox', {checked: true}).count(), 5);
  await extract().click();
  await page.getByRole('button', {name: '키워드를 만들고 있어요…', exact: true}).waitFor();
  assert.equal(await page.getByRole('checkbox', {disabled: true}).count(), 6);
  completeExtraction();
  await page.getByText('관심사 1개를 비공개로 등록했어요.', {exact: true}).waitFor();
  await page.getByText('#재즈 감상', {exact: true}).waitFor();
  await page.getByText('0/5개 선택', {exact: true}).waitFor();
  assert.equal(extractionCalls, 2);
  await page.getByRole('button', {name: '등록한 관심사와 공유 설정', exact: true}).click();
  await page.getByRole('switch', {name: '재즈 감상 공유', exact: true}).waitFor();
  assert.equal(await page.getByRole('switch', {name: '재즈 감상 공유', exact: true}).isChecked(), false);
  assert.equal(state.me.interests.length, 1);
  assert(!state.me.interests.some(interest => channels.some(channel => channel.title === interest.label)));
  // Reload retains extracted interests; one of four available channels can reuse a keyword.
  state.sources.youtube.channels = channels.slice(0, 4);
  await page.reload();
  await page.getByRole('tab', {name: '마이', exact: true}).click();
  await page.getByText('YouTube', {exact: true}).click();
  assert(await extract().isDisabled());
  await page.getByRole('checkbox', {name: channels[0].title, exact: true}).click();
  assert(!(await extract().isDisabled()));
  await extract().click();
  await page.getByText('기존 관심사에 있는 키워드를 확인했어요.', {exact: true}).waitFor();
  await page.getByText('#재즈 감상', {exact: true}).waitFor();
  assert.equal(extractionCalls, 3);
  assert.equal(state.me.interests.length, 1);
  await page.setViewportSize({width: 390, height: 900});
  await page.getByRole('checkbox', {name: channels[0].title, exact: true}).click();
  await extract().click();
  await page.getByText('#' + longKeyword, {exact: true}).waitFor();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'long fallback keywords fit mobile width');
  await page.screenshot({path: '.data/qa/youtube-keywords-mobile.png', fullPage: true});
  await page.setViewportSize({width: 1440, height: 1000});
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({path: '.data/qa/youtube-keywords-desktop.png', fullPage: true});
  assert.deepEqual(pageErrors, []);
  console.log('PASS: YouTube one-to-five-channel selection, sixth-channel limit, visible retry/progress/keyword results, private persistence, existing keyword reuse, and mobile/desktop layout');
} finally {
  completeExtraction?.();
  await browser?.close();
  const stopped = new Promise(resolve => server.once('exit', resolve));
  server.kill('SIGTERM');
  await stopped;
  await rm(scratch, {recursive: true, force: true});
}
