import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';

const {chromium} = await import(process.env.SAI_PLAYWRIGHT_MODULE || 'playwright');
const scratch = await mkdtemp(join(tmpdir(), 'sai-demo2-browser-'));
const probe = createServer();
await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);});
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const server = spawn(process.execPath, ['backend/local.mjs'], {
  env: {...process.env, SAI_PORT: String(port), SAI_DB_PATH: join(scratch, 'app.sqlite'), SAI_DEMO_DIR: join(scratch, 'demo'), YOUTUBE_CLIENT_ID: '', YOUTUBE_CLIENT_SECRET: ''},
  stdio: ['ignore', 'pipe', 'pipe'],
});
const origin = `http://127.0.0.1:${port}`;
let browser;
const serverErrors = [];
server.stderr.on('data', value => serverErrors.push(String(value)));
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), 10000);
    server.stdout.once('data', () => {clearTimeout(timer); resolve();});
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`server exited ${code}: ${serverErrors.join('')}`)));
  });
  async function call(body, token = '', query = '', expected = 200) {
    const response = await fetch(origin + '/api/app' + query, {
      method: body ? 'POST' : 'GET',
      headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  const friends = [];
  for (let i = 0; i < 5; i++) {
    const password = 'seed-password-' + crypto.randomUUID();
    const account = await call({action: 'register', username: `seed_${i}`, password, confirmPassword: password});
    const {id} = await call({action: 'saveProfile', name: `친구${i + 1}`, interests: [
      {id: `jazz-${i}`, label: '재즈', category: '음악', shared: true},
      {id: `work-${i}`, label: '머신러닝', category: '공부·일', shared: true},
      {id: `private-${i}`, label: '숨겨둔 관심사', category: '기타', shared: false},
    ], instagramHandle: `friend_${i}`, instagramVisible: true}, account.token);
    friends.push({id, token: account.token});
  }
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 390, height: 900}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => {errors.push(error.message); console.error('Browser runtime error:', error.message);});
  await mkdir('.data/qa', {recursive: true});
  await page.goto(origin);
  await page.getByText('대화의 시작을 찾는 사이', {exact: true}).waitFor();
  await page.screenshot({path: '.data/qa/login-mobile.png', fullPage: true});
  await page.getByRole('tab', {name: '회원가입', exact: true}).click();
  await page.getByLabel('아이디', {exact: true}).fill('browser_user');
  await page.getByLabel('비밀번호', {exact: true}).fill('browser-password-123');
  await page.getByLabel('비밀번호 확인', {exact: true}).fill('browser-password-123');
  await page.getByText('가입하고 시작하기', {exact: true}).click();
  await page.getByLabel('프로필 이름').waitFor();
  await page.getByLabel('프로필 이름').fill('나의프로필');
  await page.getByLabel('한 줄 소개').fill('함께 이야기해요');
  await page.getByLabel('새 관심사').fill('재즈');
  await page.getByText('관심사 추가', {exact: true}).last().click();
  await page.getByRole('switch', {name: '재즈 공유', exact: true}).click();
  await page.getByLabel('새 관심사').fill('나만의 취향');
  await page.getByText('관심사 추가', {exact: true}).last().click();
  await page.getByText('내 취향 저장', {exact: true}).click();
  await page.getByText('나를 알아가는 사이', {exact: true}).waitFor();
  const token = await page.evaluate(() => localStorage.getItem('sai-session'));
  const me = (await call(undefined, token)).me;
  const defaults = await call(undefined, token);
  assert.equal(defaults.friends.filter(person => person.isDemo).length, 24);
  const demoRoom = defaults.rooms.find(room => room.isDemo);
  assert(demoRoom && demoRoom.count === 25);
  assert(me.interests.find(t => t.label === '재즈').shared);
  assert(!me.interests.find(t => t.label === '나만의 취향').shared);
  const publicMe = (await call(undefined, '', '?profile=' + me.id)).profile;
  assert(!publicMe.interests.some(t => t.label === '나만의 취향'));
  console.log('PASS browser registration, profile editing, explicit sharing, and private defaults');

  await page.getByRole('tab', {name: '친구', exact: true}).click();
  await page.getByRole('checkbox', {name: '민수 예시 프로필 선택', exact: true}).waitFor();
  assert.equal(await page.getByRole('checkbox', {name: /예시 프로필 선택$/}).count(), 24);
  await page.screenshot({path: '.data/qa/default-demo-friends-mobile.png', fullPage: true});
  await page.getByRole('tab', {name: '그룹', exact: true}).click();
  await page.getByRole('button', {name: '24명 데모 모임 예시 모임 열기', exact: true}).click();
  await page.getByText('모임 편성하기', {exact: true}).click();
  await page.getByText('누구와 함께할까요?', {exact: true}).waitFor();
  await page.getByText('24명 선택됨', {exact: true}).waitFor();
  await page.getByRole('checkbox', {name: '민수 예시 프로필 선택', exact: true}).waitFor();
  assert.equal(await page.getByRole('checkbox', {checked: true}).count(), 24);
  assert.equal(await page.getByRole('checkbox', {name: '나의프로필 선택', exact: true}).getAttribute('aria-checked'), 'false');
  await page.getByText('다음', {exact: true}).click();
  await page.getByText('그룹 추천하기', {exact: true}).click();
  await page.getByText('이 조합은 어때요?', {exact: true}).waitFor({timeout: 30000});
  await page.getByRole('button', {name: '테이블 1 상세 보기', exact: true}).click();
  await page.getByText('예시 데이터 · Demo', {exact: true}).first().waitFor();
  await page.screenshot({path: '.data/qa/default-demo-evidence-mobile.png', fullPage: true});
  await page.getByText('뒤로', {exact: true}).click();
  await page.getByText('이 편성으로 결정', {exact: true}).click();
  await page.getByText('확정 편성 보기', {exact: true}).waitFor();
  const demoPlan = (await call(undefined, token, '?room=' + demoRoom.id)).selectedRoom.plan;
  assert.equal(demoPlan.selected.length, 24);
  assert.equal(new Set(demoPlan.groups.flat()).size, 24);
  assert(!demoPlan.selected.includes(me.id));
  console.log('PASS browser default 24 demo friends, example labels/evidence, demo-only selection, real CP-SAT, and confirmation');

  await call({action: 'requestFriend', id: me.id}, friends[0].token);
  await page.getByRole('tab', {name: '친구', exact: true}).click();
  await page.getByText('새로고침', {exact: true}).click();
  await page.getByText('수락', {exact: true}).click();
  await page.getByRole('checkbox', {name: '친구1 선택', exact: true}).click();
  await page.getByText('함께 이야기할 주제 보기', {exact: true}).click();
  await page.getByText('함께 나눌 이야기', {exact: true}).waitFor();
  await page.getByRole('button', {name: /1위 재즈/}).click();
  await page.getByText('사용자별 근거', {exact: true}).waitFor();
  assert((await page.getByText('직접 등록한 관심사', {exact: true}).count()) >= 2);
  assert.equal(await page.getByText('숨겨둔 관심사', {exact: true}).count(), 0);
  await page.screenshot({path: '.data/qa/common-evidence-mobile.png', fullPage: true});
  console.log('PASS accepted friendship, all-member common topic, and truthful manual evidence');

  const friendBefore = (await call(undefined, friends[0].token)).me;
  await call({action: 'saveProfile', ...friendBefore, interests: friendBefore.interests.map(t => ({...t, shared: t.label === '재즈' ? false : t.shared}))}, friends[0].token);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('관심사나 참가자가 바뀌었어요. 다시 비교해주세요.', {exact: true}).waitFor();
  assert.equal(await page.getByText('사용자별 근거', {exact: true}).count(), 0);
  await call({action: 'saveProfile', ...friendBefore, version: (await call(undefined, friends[0].token)).me.version}, friends[0].token);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  console.log('PASS refreshed sharing settings invalidate old comparison evidence');

  await page.getByRole('tab', {name: '마이', exact: true}).click();
  await page.getByText('LinkedIn', {exact: true}).click();
  await page.getByText('프로필 텍스트 직접 입력', {exact: true}).click();
  await page.getByLabel('LinkedIn 가져오기 텍스트').fill('Skills:\nComputer Vision\nDeep Learning\nProjects:\nVisual Recognition');
  await page.getByText('직접 입력한 관심사 가져오기', {exact: true}).click();
  await page.getByText('등록한 데이터', {exact: true}).waitFor();
  const imported = (await call(undefined, token)).me.interests.filter(t => t.source?.kind === 'linkedin');
  assert(imported.length >= 2 && imported.every(t => !t.shared));
  await page.getByRole('tab', {name: '그룹', exact: true}).click();
  await page.getByText('+ 그룹 만들기', {exact: true}).click();
  await page.getByLabel('모임 이름').fill('브라우저 통합 모임');
  await page.getByText('모임 만들기', {exact: true}).click();
  await page.getByText('브라우저 통합 모임', {exact: true}).waitFor();
  const room = (await call(undefined, token)).rooms[0];
  for (const friend of friends) await call({action: 'joinRoom', id: room.id}, friend.token);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', {name: '그룹', exact: true}).click();
  await page.getByRole('button', {name: '브라우저 통합 모임 모임 열기', exact: true}).click();
  await page.getByText('모임 편성하기', {exact: true}).click();
  await page.getByText('다음', {exact: true}).click();
  await page.getByText('그룹 추천하기', {exact: true}).click();
  await page.getByText('이 조합은 어때요?', {exact: true}).waitFor({timeout: 30000});
  assert.equal(await page.getByRole('tab', {name: /^추천 [123]$/}).count(), 3);
  await page.screenshot({path: '.data/qa/group-plans-mobile.png', fullPage: true});
  await page.getByRole('button', {name: '테이블 1 상세 보기', exact: true}).click();
  await page.getByText('쌍 연결도', {exact: true}).waitFor();
  await page.getByText('뒤로', {exact: true}).click();
  await page.getByText('이 편성으로 결정', {exact: true}).click();
  await page.getByText('확정 편성 보기', {exact: true}).waitFor();
  const saved = (await call(undefined, token, '?room=' + room.id)).selectedRoom.plan;
  assert.equal(saved.groups.flat().length, 6); assert.equal(new Set(saved.groups.flat()).size, 6);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', {name: '그룹', exact: true}).click();
  await page.getByRole('button', {name: '브라우저 통합 모임 모임 열기', exact: true}).click();
  await page.getByText('확정 편성 보기', {exact: true}).click();
  await page.getByText('확정한 편성이에요', {exact: true}).waitFor();
  console.log('PASS real CP-SAT Top-3, table metrics, owner confirmation, and saved assignment after reload');

  const secondRoom = await call({action: 'createRoom', name: '다른 모임'}, token);
  await page.getByRole('tab', {name: '그룹', exact: true}).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', {name: '다른 모임 모임 열기', exact: true}).click();
  await page.getByRole('tab', {name: '마이', exact: true}).click();
  // Pending worker isolates navigation/cancellation from a real 614MB model download.
  await page.evaluate(() => {
    window.__qaWorker = window.Worker;
    window.__qaTerminations = 0;
    window.Worker = class {postMessage() {} terminate() {window.__qaTerminations++;}};
  });
  await page.getByText('내 관심사 AI 분석', {exact: true}).click();
  await page.getByText('함께할 이야기를 찾고 있어요', {exact: true}).waitFor();
  await page.getByText('분석 중단', {exact: true}).click();
  await page.getByText('나를 알아가는 사이', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__qaTerminations), 1);
  await page.getByText('내 관심사 AI 분석', {exact: true}).click();
  await page.getByText('함께할 이야기를 찾고 있어요', {exact: true}).waitFor();
  const beforePersonal = (await call(undefined, token)).me;
  await call({action: 'saveProfile', ...beforePersonal, interests: [...beforePersonal.interests, {id: 'changed-private', label: '새로운 비공개 취향', category: '기타', shared: false}]}, token);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText('나의 관심사가 바뀌었어요. 다시 분석해주세요.', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__qaTerminations), 2);
  await page.evaluate(() => {window.Worker = window.__qaWorker;});
  console.log('PASS personal-analysis navigation after viewing another room, explicit cancellation, and input-change cancellation');

  await page.getByRole('tab', {name: '친구', exact: true}).click();
  await page.getByRole('button', {name: '친구1 프로필 보기', exact: true}).click();
  await page.getByText('Instagram 프로필 열기', {exact: true}).waitFor();
  await page.getByRole('tab', {name: '마이', exact: true}).click();
  await page.getByText('프로필 링크 / QR 공유', {exact: true}).click();
  await page.getByText('링크 복사', {exact: true}).waitFor();
  assert.equal(await page.locator('svg').count() > 0, true);
  await page.getByRole('tab', {name: '마이', exact: true}).click();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.screenshot({path: '.data/qa/my-desktop.png', fullPage: true});
  await page.getByText('예시 데이터로 체험하기', {exact: true}).click();
  await page.getByText('예시 프로필로 바로 체험', {exact: true}).waitFor();
  await page.getByText('← 내 계정으로 돌아가기 · 예시 체험 중', {exact: true}).click();
  await page.getByText('우리 사이, 어떤 이야기?', {exact: true}).waitFor();
  assert.equal(await page.getByText('예시 프로필로 바로 체험', {exact: true}).count(), 0);
  console.log('PASS profile QR, accepted-friend social links, desktop layout, and isolated example experience');

  const guest = await browser.newPage({viewport: {width: 390, height: 900}});
  guest.on('pageerror', error => errors.push(error.message));
  await guest.goto(origin + '/?room=' + room.id);
  await guest.waitForLoadState('networkidle');
  await guest.getByLabel('아이디', {exact: true}).fill('seed_1');
  // Create a separate account through the UI so the received invite must survive profile setup.
  await guest.getByRole('tab', {name: '회원가입', exact: true}).click();
  await guest.getByLabel('아이디', {exact: true}).fill('invited_user');
  await guest.getByLabel('비밀번호', {exact: true}).fill('invited-password-123');
  await guest.getByLabel('비밀번호 확인', {exact: true}).fill('invited-password-123');
  await guest.getByText('가입하고 시작하기', {exact: true}).click();
  await guest.getByLabel('프로필 이름').fill('초대받은사람');
  await guest.getByText('내 취향 저장', {exact: true}).click();
  await guest.getByText('함께할 자리를 찾아요', {exact: true}).waitFor();
  assert.equal(await guest.getByLabel('모임 초대 링크 또는 코드').inputValue(), room.id);
  await guest.getByText('모임 참여하기', {exact: true}).click();
  await guest.getByText('브라우저 통합 모임', {exact: true}).waitFor();
  console.log('PASS incoming room link survives registration and first profile creation');
  assert.deepEqual(errors, []);
  console.log('PASS no browser runtime errors; screenshots in .data/qa');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
