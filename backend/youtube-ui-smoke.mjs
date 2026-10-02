import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {transform} from 'esbuild';

let source = await fs.readFile('mobile/SAIApp.tsx', 'utf8');
assert.match(source, /const youtubeAnalysisTimeoutMs = 150_000;/, 'YouTube analysis must have a bounded client timeout below the server maximum');
source = source.replace(/^import .*;\n/gm, '');
source = source.replace('  function renderPage() {', `
  globalThis.__youtubeUi = {
    extractYouTubeInterests, navigate, resetAccountState,
    setBooting,
    setChannels(value) { setYoutubeChannelIds(value); },
    setSession(nextToken, nextData) { session.current = nextToken; accountIdentity.current = nextData.account?.username || ''; setToken(nextToken); setData(nextData); },
    snapshot() { return {youtubeChannelIds, youtubeAnalyzing, youtubeFeedback, page, data}; },
  };
  function renderPage() {`);
source += '\nexport {AccountApp};\n';

const prelude = `
const __hooks = globalThis.__hooks;
const useState = __hooks.useState, useRef = __hooks.useRef, useEffect = __hooks.useEffect;
const React = {}, Fragment = 'Fragment';
const ActivityIndicator='ActivityIndicator', Image='Image', Pressable='Pressable', ScrollView='ScrollView', Share={share:async()=>{}}, Switch='Switch', Text='Text', TextInput='TextInput', View='View';
const Platform={OS:'web'}, SafeAreaProvider='SafeAreaProvider', SafeAreaView='SafeAreaView', StatusBar='StatusBar';
const Linking={getInitialURL:async()=>null,addEventListener:()=>({remove(){}}),parse:()=>({queryParams:{}}),createURL:()=>''};
const Clipboard={setStringAsync:async()=>{}}, ImagePicker={}, manipulateAsync=async()=>({}), SaveFormat={JPEG:'jpeg'}, QRCode='QRCode';
const DemoApp='DemoApp', Avatar='Avatar', Button='Button', Card='Card', Empty='Empty', Heading='Heading', Icon='Icon', Metric='Metric', QualityRow='QualityRow', Score='Score', Section='Section', SourceList='SourceList', Tag='Tag', TopicRow='TopicRow';
const s=new Proxy({}, {get:(_,key)=>String(key)});
const canonical=value=>String(value).trim().toLowerCase(), categories=['전체','음악','기타'], eligibleMatches=value=>value, findMatches=()=>[], positiveInterests=p=>p.interests||[];
const preferenceNames={like:'좋아해요',avoid:'피하고 싶어요',explore:'해보고 싶어요'}, preferenceOf=t=>t.preference||'like', preferenceQuestions={like:'좋아하는 것',avoid:'피하고 싶은 것',explore:'해보고 싶은 것'};
const rankInterests=value=>value, scoreGroup=()=>({utility:0}), toCommonInterest=value=>value, toDemoPlan=value=>value, toDemoProfile=value=>value, toEvidence=value=>value;
const analyzePersonalInterests=async()=>[], browserSemantic=async()=>[], browserTaste=async()=>[], chooseAvatar=async()=>null, rankConversationTopics=value=>value;
class ServiceError extends Error { constructor(message,status){super(message);this.status=status;} }
globalThis.__ServiceError = ServiceError;
const getServiceState=(...args)=>globalThis.__youtubeService.getState(...args);
const requestSharedProfile=async()=>null;
const requestAction=(...args)=>globalThis.__youtubeService.action(...args);
const tokenClear=async()=>{}, tokenRead=async()=>null, tokenSave=async()=>{};
const require=()=>'';
`;
const compiled = await transform(prelude + source, {loader: 'tsx', format: 'esm', target: 'es2022', jsxFactory: '__hooks.h', jsxFragment: 'Fragment'});

const hookValues = [];
let hookCursor = 0;
globalThis.__hooks = {
  h(type, props, ...children) {return {type, props: {...(props || {}), children}};},
  useEffect() {},
  useRef(initial) {const index = hookCursor++; if (hookValues[index] === undefined) hookValues[index] = {current: initial}; return hookValues[index];},
  useState(initial) {const index = hookCursor++; if (hookValues[index] === undefined) hookValues[index] = typeof initial === 'function' ? initial() : initial; return [hookValues[index], value => {hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value;}];},
};

const channels = Array.from({length: 6}, (_, index) => ({id: `channel-${index + 1}`, title: `채널 ${index + 1}`, description: '설명', url: ''}));
const profile = interests => ({id: 'me', name: '나', bio: '', color: '#18181B', interests});
const state = interests => ({
  account: {username: 'youtube-user'}, me: profile(interests), friends: [], requests: [], sent: [], rooms: [], selectedRoom: null,
  sources: {youtube: {status: 'ok', itemCount: channels.length, candidateCount: 0, samples: [], counts: {}, channels}, linkedin: {status: 'never', itemCount: 0, candidateCount: 0, samples: [], counts: {}}},
});
let serverState = state([]), actionImpl = async () => ({}), getStateImpl = async () => serverState;
globalThis.__youtubeService = {action: (...args) => actionImpl(...args), getState: (...args) => getStateImpl(...args)};
const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
let tree;
function render() {hookCursor = 0; tree = module.AccountApp({onExample() {}}); return globalThis.__youtubeUi;}
function textContent(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.props?.children || []).flat(Infinity).map(textContent).join(' ');
}

let ui = render(); ui.setBooting(false); ui = render();
ui.setSession('youtube-token', serverState); ui.navigate('youtube'); ui.setChannels([channels[0].id]); ui = render();
let releaseSuccess;
let actionCalls = 0;
actionImpl = async (token, action, body) => {
  actionCalls++;
  assert.equal(token, 'youtube-token'); assert.equal(action, 'extractYouTubeInterests'); assert.deepEqual(body.channelIds, [channels[0].id]);
  return new Promise(resolve => {releaseSuccess = () => {
    const saved = {id: 'jazz', label: '재즈 감상', category: '음악', shared: false, preference: 'like'};
    serverState = state([saved]); resolve({count: 1, summary: '키워드 1개를 저장했어요.', labels: ['재즈 감상'], interests: [saved], fallback: false});
  };});
};
const pending = ui.extractYouTubeInterests(); ui = render();
assert.equal(ui.snapshot().youtubeAnalyzing, true);
assert.match(ui.snapshot().youtubeFeedback.message, /키워드를 만들고/);
await ui.extractYouTubeInterests();
assert.equal(actionCalls, 1, 'a second click while analyzing must be ignored');
releaseSuccess(); await pending; ui = render();
assert.equal(ui.snapshot().youtubeAnalyzing, false); assert.deepEqual(ui.snapshot().youtubeChannelIds, []);
assert.deepEqual(ui.snapshot().youtubeFeedback.labels, ['재즈 감상']);
assert.match(textContent(tree), /재즈 감상/); assert.match(textContent(tree), /프로필에서 키워드 확인/);
console.log('PASS YouTube UI accepts one channel, blocks duplicate analysis, and renders persisted keyword labels inline');

ui.setChannels([channels[1].id, channels[2].id]); ui = render();
actionImpl = async () => {throw new globalThis.__ServiceError('분석 서버가 응답하지 않았어요.', 503);};
await ui.extractYouTubeInterests(); ui = render();
assert.deepEqual(ui.snapshot().youtubeChannelIds, [channels[1].id, channels[2].id]);
assert.equal(ui.snapshot().youtubeFeedback.kind, 'error'); assert.match(textContent(tree), /분석 서버가 응답하지 않았어요/);
console.log('PASS YouTube UI keeps channel selection and renders failures beside the analysis action');

const manual = {id: 'manual', label: '기존 수동 관심사', category: '기타', shared: false, preference: 'like'};
actionImpl = async () => ({count: 0, summary: '잘못된 빈 결과', labels: [], interests: [manual], fallback: false});
await ui.extractYouTubeInterests(); ui = render();
assert.equal(ui.snapshot().youtubeFeedback.kind, 'error'); assert.deepEqual(ui.snapshot().youtubeChannelIds, [channels[1].id, channels[2].id]);
assert(!textContent(tree).includes('#기존 수동 관심사'), 'explicit empty labels must not fall back to unrelated profile interests');
console.log('PASS explicit empty labels cannot be mistaken for existing manual interests');

let releaseOld, releaseNew, raceCalls = 0;
actionImpl = async () => new Promise(resolve => {raceCalls++; if (raceCalls === 1) releaseOld = resolve; else releaseNew = resolve;});
const oldRequest = ui.extractYouTubeInterests(); ui = render(); ui.navigate('my'); ui = render();
assert.equal(ui.snapshot().youtubeAnalyzing, false); assert.equal(ui.snapshot().youtubeFeedback, null);
ui.navigate('youtube'); ui = render();
const newRequest = ui.extractYouTubeInterests(); ui = render();
assert.equal(raceCalls, 2, 'leaving and immediately returning must allow a new request'); assert.equal(ui.snapshot().youtubeAnalyzing, true);
releaseOld({count: 1, summary: '이전 요청', labels: ['노출되면 안 됨'], interests: []}); await oldRequest; ui = render();
assert.equal(ui.snapshot().youtubeAnalyzing, true, 'the old aborted request must not clear the new request state');
assert.equal(ui.snapshot().youtubeFeedback.kind, 'progress'); assert(!textContent(tree).includes('노출되면 안 됨'));
const raceSaved = {id: 'new-keyword', label: '새 요청 키워드', category: '기타', shared: false, preference: 'like', source: {kind: 'youtube'}};
serverState = state([raceSaved]); releaseNew({count: 1, summary: '새 요청 완료', labels: ['새 요청 키워드'], interests: [raceSaved]}); await newRequest; ui = render();
assert.deepEqual(ui.snapshot().youtubeFeedback.labels, ['새 요청 키워드']); assert.equal(ui.snapshot().youtubeAnalyzing, false);
console.log('PASS leave/re-enter starts immediately and an old aborted response cannot reset the new request');

ui.setChannels([channels[3].id]); ui = render();
const refreshSaved = {id: 'refresh-keyword', label: '저장 완료 키워드', category: '기타', shared: false, preference: 'like', source: {kind: 'youtube'}};
actionImpl = async () => ({count: 1, summary: '키워드를 저장했어요.', labels: ['저장 완료 키워드'], interests: [refreshSaved]});
getStateImpl = async () => {throw new globalThis.__ServiceError('새로고침 실패', 503);};
await ui.extractYouTubeInterests(); ui = render();
assert.equal(ui.snapshot().youtubeFeedback.kind, 'success'); assert.deepEqual(ui.snapshot().youtubeFeedback.labels, ['저장 완료 키워드']);
assert.match(ui.snapshot().youtubeFeedback.message, /저장했어요/); assert.match(ui.snapshot().youtubeFeedback.message, /다시 불러오지 못했어요/);
assert.deepEqual(ui.snapshot().youtubeChannelIds, []);
console.log('PASS a post-save refresh failure keeps persisted labels visible with reload guidance');

ui.resetAccountState(); ui = render();
assert.deepEqual(ui.snapshot().youtubeChannelIds, []); assert.equal(ui.snapshot().youtubeFeedback, null);
console.log('PASS account reset clears account-bound YouTube UI state');
