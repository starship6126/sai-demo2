import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {transform} from 'esbuild';

let source = await fs.readFile('mobile/SAIApp.tsx', 'utf8');
source = source.replace(/^import .*;\n/gm, '');
source = source.replace('  function renderPage() {', `
  globalThis.__accountUi = {
    authenticate, editAvatar, editProfile, expireSession, load, logout, resetAccountState, saveProfile,
    runAction() { return run(() => serviceAction(token, 'testAction')); },
    setAuthInputs(nextUsername, nextPassword) { setUsername(nextUsername); setPassword(nextPassword); },
    setBooting, setDraft, setLinkedinText, setQuickText, setCandidates,
    setSession(nextToken, nextData) { session.current = nextToken; accountIdentity.current = nextData.account?.username || ''; setToken(nextToken); setData(nextData); },
    snapshot() { return {data, token, draft, profileConflict, profileConflictDetected, linkedinText, quickText, candidates, page, error, notice}; },
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
const analyzePersonalInterests=async()=>[], browserSemantic=async()=>[], browserTaste=async()=>[], chooseAvatar=(...args)=>globalThis.__accountService.chooseAvatar(...args), rankConversationTopics=value=>value;
class ServiceError extends Error { constructor(message,status){super(message);this.status=status;} }
globalThis.__ServiceError = ServiceError;
const getServiceState=(...args)=>globalThis.__accountService.getState(...args);
const requestSharedProfile=(...args)=>globalThis.__accountService.getShared(...args);
const requestAction=(...args)=>globalThis.__accountService.action(...args);
const tokenClear=()=>globalThis.__accountService.clearToken(), tokenRead=async()=>null, tokenSave=value=>globalThis.__accountService.saveToken(value);
const require=()=>'';
`;
const compiled = await transform(prelude + source, {loader: 'tsx', format: 'esm', target: 'es2022', jsxFactory: '__hooks.h', jsxFragment: 'Fragment'});

const hookValues = [];
let hookCursor = 0;
globalThis.__hooks = {
  h(type, props, ...children) { return {type, props: {...(props || {}), children}}; },
  useEffect() {},
  useRef(initial) {const index = hookCursor++; if (hookValues[index] === undefined) hookValues[index] = {current: initial}; return hookValues[index];},
  useState(initial) {const index = hookCursor++; if (hookValues[index] === undefined) hookValues[index] = typeof initial === 'function' ? initial() : initial; return [hookValues[index], value => {hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value;}];},
};

let savedToken = '';
let actionImpl = async () => ({});
let stateImpl = async () => ({account: null, me: null, friends: [], requests: [], sent: [], rooms: [], selectedRoom: null});
let avatarImpl = async () => null;
globalThis.__accountService = {
  action: (...args) => actionImpl(...args), getState: (...args) => stateImpl(...args), getShared: async () => null,
  chooseAvatar: (...args) => avatarImpl(...args),
  clearToken: async () => {savedToken = '';}, saveToken: async value => {savedToken = value;},
};

const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
let tree;
function render() {hookCursor = 0; tree = module.AccountApp({onExample() {}}); return globalThis.__accountUi;}
function state(username, me = null, account = {}) {return {account: {username, ...account}, me, friends: [], requests: [], sent: [], rooms: [], selectedRoom: null};}
function profile(id, name, version) {return {id, name, bio: '', color: '#18181B', interests: [], version};}
function findButton(node, label) {
  if (!node || typeof node !== 'object') return null;
  const children = node.props?.children || [];
  if (node.type === 'Button' && children.flat(Infinity).join('') === label) return node;
  for (const child of children.flat(Infinity)) {const found = findButton(child, label); if (found) return found;}
  return null;
}

let ui = render(); ui.setBooting(false); ui = render();
const a = profile('profile-a', '계정 A', 'a'.repeat(64));
ui.setSession('token-a', state('account_a', a));
ui.setLinkedinText('A 계정만 볼 수 있는 LinkedIn 원문'); ui.setQuickText('A의 취향 원문');
ui.setCandidates([{id: 'a-secret', label: 'A 후보', category: '기타', shared: false}]);
render();
actionImpl = async (_token, action) => {assert.equal(action, 'logout'); return {ok: true};};
await ui.logout(); ui = render();
assert.equal(ui.snapshot().data.account, null); assert.equal(ui.snapshot().linkedinText, ''); assert.equal(ui.snapshot().quickText, '');
assert.deepEqual(ui.snapshot().candidates, []); assert.equal(savedToken, '');
ui.setAuthInputs('account_b', 'password'); render();
actionImpl = async (_token, action) => {assert.equal(action, 'login'); return {token: 'token-b'};};
stateImpl = async () => state('account_b', null, {instagramHandle: 'b_insta', linkedinHandle: 'b-linkedin'});
await ui.authenticate(); ui = render();
assert.equal(ui.snapshot().data.account.username, 'account_b'); assert.equal(ui.snapshot().draft.name, '');
assert.equal(ui.snapshot().draft.instagramHandle, 'b_insta'); assert.equal(ui.snapshot().draft.linkedinHandle, 'b-linkedin'); assert.equal(ui.snapshot().linkedinText, '');
console.log('PASS A logout -> B onboarding clears private state and keeps B signup defaults');

const b = profile('profile-b', '계정 B', 'b'.repeat(64));
ui.setSession('token-b', state('account_b', b)); ui.setLinkedinText('만료된 B 세션의 원문'); render();
stateImpl = async () => ({account: null, me: null, friends: [], requests: [], sent: [], rooms: [], selectedRoom: null});
await ui.load('token-b'); ui = render();
assert.equal(ui.snapshot().data.account, null); assert.equal(ui.snapshot().linkedinText, ''); assert.equal(ui.snapshot().token, ''); assert.match(ui.snapshot().notice, /세션이 만료/);
console.log('PASS session invalidation clears private state and local credentials');

ui.setSession('token-a', state('account_a', a)); ui.setLinkedinText('401 이전 A 원문'); ui = render();
actionImpl = async () => {throw new globalThis.__ServiceError('unauthorized', 401);};
await ui.runAction(); ui = render();
assert.equal(ui.snapshot().data.account, null); assert.equal(ui.snapshot().linkedinText, ''); assert.equal(ui.snapshot().token, ''); assert.match(ui.snapshot().notice, /세션이 만료/);
console.log('PASS action 401 uses the same account-boundary reset as GET expiry');

ui.setSession('token-a', state('account_a', a)); ui.setLinkedinText('직접 계정 변경 전 A 원문'); ui = render();
stateImpl = async () => state('account_b', b);
await ui.load('token-a'); ui = render();
assert.equal(ui.snapshot().data.account.username, 'account_b'); assert.equal(ui.snapshot().data.me.id, 'profile-b'); assert.equal(ui.snapshot().linkedinText, '');
console.log('PASS direct account identity change resets A state before applying B data');

ui.setSession('token-a', state('account_a', a)); render();
let releaseOld;
stateImpl = () => new Promise(resolve => {releaseOld = () => resolve(state('account_a', a));});
const oldLoad = ui.load('token-a');
ui.setAuthInputs('account_b', 'password'); render();
actionImpl = async () => ({token: 'token-b'}); stateImpl = async () => state('account_b', b);
await ui.authenticate(); releaseOld(); await oldLoad; ui = render();
assert.equal(ui.snapshot().data.account.username, 'account_b'); assert.equal(ui.snapshot().data.me.id, 'profile-b');
console.log('PASS delayed A load cannot overwrite authenticated B state');

ui.editProfile(); ui = render(); ui.setDraft({...ui.snapshot().draft, name: 'B 로컬 편집'}); ui = render();
const latestB = profile('profile-b', 'B 서버 최신본', 'c'.repeat(64));
actionImpl = async (_token, action, body) => {assert.equal(action, 'saveProfile'); assert.equal(body.version, 'b'.repeat(64)); throw new globalThis.__ServiceError('프로필이 변경됐어요.', 409);};
stateImpl = async () => state('account_b', latestB);
await ui.saveProfile(); ui = render();
assert.equal(ui.snapshot().draft.name, 'B 로컬 편집'); assert.match(ui.snapshot().error, /현재 편집 내용은 그대로/); assert.equal(ui.snapshot().profileConflict.name, 'B 서버 최신본');
const reload = findButton(tree, '최신 프로필 불러오기'); assert(reload, 'conflict reload action must be rendered');
reload.props.onPress(); ui = render();
assert.equal(ui.snapshot().draft.name, 'B 서버 최신본'); assert.equal(ui.snapshot().profileConflict, null);
console.log('PASS 409 keeps dirty draft and explicit latest-profile action replaces it');

ui.setSession('token-b', state('account_b', latestB)); ui = render(); ui.editProfile(); ui = render(); ui.setDraft({...ui.snapshot().draft, name: '삭제 충돌 전 편집'}); ui = render();
actionImpl = async () => {throw new globalThis.__ServiceError('프로필이 삭제됐어요.', 409);};
stateImpl = async () => state('account_b', null);
await ui.saveProfile(); ui = render();
assert.equal(ui.snapshot().draft.name, '삭제 충돌 전 편집'); assert.equal(ui.snapshot().profileConflict, null); assert.equal(ui.snapshot().profileConflictDetected, true);
const reloadDeleted = findButton(tree, '최신 프로필 불러오기'); assert(reloadDeleted, 'deleted-profile conflict must still render the reload action');
reloadDeleted.props.onPress(); ui = render();
assert.equal(ui.snapshot().draft.name, ''); assert.equal(ui.snapshot().profileConflictDetected, false);
console.log('PASS deleted-profile conflict preserves the draft and explicitly reloads a new blank profile');

ui.setSession('token-a', state('account_a', a)); ui = render(); ui.editProfile(); ui = render();
let releaseAvatar;
avatarImpl = () => new Promise(resolve => {releaseAvatar = () => resolve('data:image/jpeg;base64,account-a');});
const oldAvatar = ui.editAvatar();
ui.resetAccountState(); ui = render(); ui.setSession('token-b', state('account_b', b)); ui = render(); ui.editProfile(); ui = render();
releaseAvatar(); await oldAvatar; ui = render();
assert.equal(ui.snapshot().draft.id, 'profile-b'); assert.equal(ui.snapshot().draft.avatar, undefined);
console.log('PASS delayed A avatar selection cannot resurrect A draft in B session');
