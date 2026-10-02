import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, Platform, Pressable, ScrollView, Share, Switch, Text, TextInput, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {StatusBar} from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import {manipulateAsync, SaveFormat} from 'expo-image-manipulator';
import QRCode from 'react-native-qrcode-svg';
import DemoApp, {Avatar, Button, Card, Empty, Heading, Icon, Metric, QualityRow, Score, Section, SourceList, Tag, TopicRow, demoStyles as s} from './DemoApp';
import {canonical, categories, eligibleMatches, findMatches, positiveInterests, preferenceNames, preferenceOf, preferenceQuestions, type Interest, type Match, type Preference, type Profile} from '../shared/matching';
import {rankInterests, scoreGroup, type GroupPlan} from '../shared/grouping';
import type {PersonalTopic} from '../shared/interest-profile';
import type {CommonInterest, DemoPlan} from '../shared/demo-types';
import {toCommonInterest, toDemoPlan, toDemoProfile, toEvidence} from '../shared/service-presentation';
import {getServiceState, getSharedProfile as requestSharedProfile, serviceAction as requestAction, ServiceError, tokenClear, tokenRead, tokenSave, type EditableProfile, type LinkedInImportJob, type ServiceState, type SourceState} from './service-api';
import {analyzePersonalInterests} from './interest-profile-web';
import {browserSemantic} from './semantic-web';
import {browserTaste} from './taste-web';
import {chooseAvatar} from './avatar-web';
import {rankConversationTopics} from '../shared/conversation-topics';

type Tab = '친구' | '그룹' | '마이';
type Page = 'friends' | 'friend-add' | 'friend-detail' | 'common' | 'common-detail' | 'groups' | 'room-create' | 'room-join' | 'room' | 'participants' | 'conditions' | 'group-result' | 'table-detail' | 'my' | 'profile-edit' | 'share' | 'youtube' | 'linkedin' | 'my-interests' | 'my-interest-detail' | 'analysis';
const localDemoEnabled = process.env.EXPO_PUBLIC_LOCAL_DEMO !== '0';
const linkedInJobPrefix = 'sai-linkedin-import:';
const linkedInAccountKey = 'sai-linkedin-import-account';
const youtubeAnalysisTimeoutMs = 150_000;
const empty: ServiceState = {account: null, me: null, friends: [], requests: [], sent: [], rooms: [], selectedRoom: null};
const newInterestId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const blankProfile: EditableProfile = {id: '', name: '', bio: '', color: '#18181B', interests: []};
const names = (people: Profile[]) => people.slice(0, 3).map(p => p.name).join(' · ') + (people.length > 3 ? ` 외 ${people.length - 3}명` : '');
const sharedStamp = (people: Profile[]) => JSON.stringify(people.map(p => ({id: p.id, name: p.name, interests: p.interests.filter(t => t.shared).map(t => ({id: t.id, label: t.label, category: t.category, preference: preferenceOf(t), source: t.source})).sort((a, b) => a.id.localeCompare(b.id))})).sort((a, b) => a.id.localeCompare(b.id)));
function codeFrom(value: string, kind: 'profile' | 'room') {
  const input = value.trim();
  try {return new URL(input).searchParams.get(kind) || input;} catch {return input;}
}
function linkedInProfileUrl(value?: string) {
  const input = value?.trim();
  if (!input) return '';
  return /^https?:\/\//i.test(input) ? input : `https://www.linkedin.com/in/${input.replace(/^@/, '')}/`;
}
function waitForLinkedInPoll(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 3000);
    signal.addEventListener('abort', () => {clearTimeout(timer); resolve();}, {once: true});
  });
}
function Choice({checked, label, detail, detailLines, onPress, disabled = false}: {checked: boolean; label: string; detail?: string; detailLines?: number; onPress: () => void; disabled?: boolean}) {
  return <Pressable accessibilityRole="checkbox" accessibilityLabel={label} accessibilityState={{checked, disabled}} aria-checked={checked} disabled={disabled} onPress={onPress} style={[s.row, {paddingVertical: 12}, disabled && s.disabled]}><View style={[s.check, checked && s.checkSelected]}>{checked && <Icon name="checkmark" size={15} color="white"/>}</View><View style={s.flex}><Text style={s.label}>{label}</Text>{detail && <Text style={s.small} numberOfLines={detailLines}>{detail}</Text>}</View></Pressable>;
}

export default function SAIApp() {
  const [example, setExample] = useState(false);
  if (example) return <View style={{flex: 1}}><View style={{backgroundColor: '#F6F6F7', padding: 10}}><Pressable accessibilityRole="button" onPress={() => setExample(false)}><Text style={{textAlign: 'center', color: '#18181B', fontSize: 13}}>← 내 계정으로 돌아가기 · 예시 체험 중</Text></Pressable></View><DemoApp/></View>;
  return <SafeAreaProvider><AccountApp onExample={() => setExample(true)}/></SafeAreaProvider>;
}

function AccountApp({onExample}: {onExample: () => void}) {
  const [data, setData] = useState<ServiceState>(empty);
  const [token, setToken] = useState('');
  const session = useRef('');
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('친구');
  const [page, setPage] = useState<Page>('friends');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [draft, setDraft] = useState<EditableProfile>(blankProfile);
  const [profileConflict, setProfileConflict] = useState<EditableProfile | null>(null);
  const [profileConflictDetected, setProfileConflictDetected] = useState(false);
  const [input, setInput] = useState('');
  const [category, setCategory] = useState('음악');
  const [preference, setPreference] = useState<Preference>('like');
  const [quickText, setQuickText] = useState('');
  const [candidates, setCandidates] = useState<Interest[]>([]);
  const [search, setSearch] = useState('');
  const [friendIds, setFriendIds] = useState<string[]>([]);
  const [includeMe, setIncludeMe] = useState(true);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<Profile | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [roomId, setRoomId] = useState<string>();
  const roomRef = useRef<string | undefined>(undefined);
  const [roomName, setRoomName] = useState('');
  const [participantIds, setParticipantIds] = useState<string[]>([]);
  const [tableSize, setTableSize] = useState(4);
  const [useAI, setUseAI] = useState(false);
  const [useBridge, setUseBridge] = useState(true);
  const [bridgeStatus, setBridgeStatus] = useState('');
  const [bridgeMessage, setBridgeMessage] = useState('');
  const [groupBridgeTopics, setGroupBridgeTopics] = useState<Match[]>([]);
  const [commonPeople, setCommonPeople] = useState<Profile[]>([]);
  const [matches, setMatches] = useState<Match[]>([]);
  const [onlyAll, setOnlyAll] = useState(false);
  const [filter, setFilter] = useState('전체');
  const [topic, setTopic] = useState<CommonInterest | null>(null);
  const [plans, setPlans] = useState<DemoPlan[]>([]);
  const [planIndex, setPlanIndex] = useState(0);
  const [groupPeople, setGroupPeople] = useState<Profile[]>([]);
  const [savedPlan, setSavedPlan] = useState(false);
  const [table, setTable] = useState<DemoPlan['groups'][number] | null>(null);
  const [share, setShare] = useState<{title: string; url: string; code: string} | null>(null);
  const [linkedinText, setLinkedinText] = useState('');
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [linkedinJob, setLinkedinJob] = useState<LinkedInImportJob | null>(null);
  const [linkedinCandidates, setLinkedinCandidates] = useState<Interest[]>([]);
  const [linkedinSelected, setLinkedinSelected] = useState<string[]>([]);
  const [linkedinProgress, setLinkedinProgress] = useState('');
  const [linkedinBusy, setLinkedinBusy] = useState(false);
  const [linkedinManualOpen, setLinkedinManualOpen] = useState(false);
  const [youtubeChannelIds, setYoutubeChannelIds] = useState<string[]>([]);
  const [youtubeAnalyzing, setYoutubeAnalyzing] = useState(false);
  const [youtubeFeedback, setYoutubeFeedback] = useState<{kind: 'progress' | 'success' | 'error'; message: string; labels: string[]} | null>(null);
  const [personal, setPersonal] = useState<PersonalTopic[]>([]);
  const [ownTopic, setOwnTopic] = useState<PersonalTopic | null>(null);
  const [progress, setProgress] = useState('');
  const [returnPage, setReturnPage] = useState<Page>('my');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const linkedinOperation = useRef<AbortController | null>(null);
  const youtubeOperation = useRef<AbortController | null>(null);
  const linkedinBusyRef = useRef(false);
  const linkedinStartRef = useRef(false);
  const linkedinAccountRef = useRef('');
  const lifecycle = useRef<AbortController | null>(null);
  const accountLifecycle = useRef<AbortController | null>(null);
  const accountGeneration = useRef(0);
  const accountIdentity = useRef('');
  const mounted = useRef(true);
  const loadVersion = useRef(0);
  const scroll = useRef<ScrollView | null>(null);
  const pendingInvite = useRef<{kind: 'room' | 'profile'; id: string} | null>(null);
  const [inviteVersion, setInviteVersion] = useState(0);
  const personalInput = useRef<string | undefined>(undefined);
  const activePlan = plans[planIndex];
  const room = data.selectedRoom;
  const canConfirm = room?.owner === data.me?.id;
  const chosenFriends = [...(includeMe && data.me ? [data.me] : []), ...data.friends.filter(p => friendIds.includes(p.id))];
  const selectedPeople = (room?.members || []).filter(p => participantIds.includes(p.id));
  const shownMatches = rankInterests(matches, commonPeople).filter(m => (filter === '전체' || m.category === filter) && (!onlyAll || commonPeople.every(p => m.members.includes(p.id))));

  function serviceAction<T>(auth: string, action: string, body: Record<string, unknown> = {}, signal = accountLifecycle.current?.signal) {
    return requestAction<T>(auth, action, body, signal);
  }
  function getSharedProfile(auth: string, id: string, signal = accountLifecycle.current?.signal) {
    return requestSharedProfile(auth, id, signal);
  }

  function linkedInStorageKey(account = data.account?.username) {return account ? `${linkedInJobPrefix}${account}` : '';}
  function rememberLinkedInJob(job: LinkedInImportJob) {
    if (Platform.OS !== 'web') return;
    const key = linkedInStorageKey();
    if (key) globalThis.localStorage?.setItem(key, JSON.stringify({jobId: job.jobId, url: job.url, startedAt: Date.now()}));
  }
  function forgetLinkedInJob(account = data.account?.username) {
    if (Platform.OS !== 'web' || !account) return;
    globalThis.localStorage?.removeItem(`${linkedInJobPrefix}${account}`);
  }
  function resetAccountState() {
    accountGeneration.current += 1; loadVersion.current += 1;
    operation.current?.abort(); operation.current = null;
    linkedinOperation.current?.abort(); linkedinOperation.current = null;
    youtubeOperation.current?.abort(); youtubeOperation.current = null;
    accountLifecycle.current?.abort(); accountLifecycle.current = new AbortController();
    busyRef.current = false; linkedinBusyRef.current = false; linkedinStartRef.current = false;
    setBusy(false); setError(''); setNotice(''); setData(empty); setDraft(blankProfile); setProfileConflict(null); setProfileConflictDetected(false);
    setTab('친구'); setPage('friends'); setUsername(''); setPassword(''); setConfirmation('');
    setInput(''); setCategory('음악'); setPreference('like'); setQuickText(''); setCandidates([]); setSearch('');
    setFriendIds([]); setIncludeMe(true); setCode(''); setPreview(null); setRemoveConfirm(false);
    roomRef.current = undefined; setRoomId(undefined); setRoomName(''); setParticipantIds([]); setTableSize(4); setUseAI(false); setUseBridge(true);
    setBridgeStatus(''); setBridgeMessage(''); setGroupBridgeTopics([]); setCommonPeople([]); setMatches([]); setOnlyAll(false); setFilter('전체'); setTopic(null);
    setPlans([]); setPlanIndex(0); setGroupPeople([]); setSavedPlan(false); setTable(null); setShare(null);
    setLinkedinText(''); setLinkedinUrl(''); setLinkedinJob(null); setLinkedinCandidates([]); setLinkedinSelected([]); setLinkedinProgress(''); setLinkedinBusy(false); setLinkedinManualOpen(false);
    setYoutubeChannelIds([]); setYoutubeAnalyzing(false); setYoutubeFeedback(null); setPersonal([]); setOwnTopic(null); setProgress(''); setReturnPage('my'); setDeleteConfirm(false);
    personalInput.current = undefined; linkedinAccountRef.current = '';
  }
  async function expireSession() {
    resetAccountState(); accountIdentity.current = ''; session.current = ''; setToken('');
    await tokenClear(); setNotice('세션이 만료되었어요. 다시 로그인해주세요.');
  }
  async function pollLinkedInJob(job: LinkedInImportJob, suppliedController?: AbortController) {
    if (linkedinBusyRef.current) return;
    const generation = accountGeneration.current, auth = session.current;
    const controller = suppliedController || new AbortController();
    linkedinOperation.current = controller; linkedinBusyRef.current = true; setLinkedinBusy(true); setError('');
    try {
      for (let attempt = 0; attempt < 200 && !controller.signal.aborted; attempt++) {
        const result = await serviceAction<LinkedInImportJob>(token, 'pollLinkedInImport', {jobId: job.jobId}, controller.signal);
        if (controller.signal.aborted || generation !== accountGeneration.current || auth !== session.current) return;
        setLinkedinJob(result);
        if (result.status === 'ready') {
          const rows = (result.candidates || []).slice(0, 5).map(item => ({...item, preference: 'explore' as const, shared: false}));
          setLinkedinCandidates(rows); setLinkedinSelected(rows.map(item => item.id));
          setLinkedinProgress(`${rows.length}개의 관심사 후보를 찾았어요. 근거를 확인하고 저장할 항목을 골라주세요.`);
          rememberLinkedInJob(result); return;
        }
        if (result.status === 'failed') {forgetLinkedInJob(); throw new Error(result.error || 'LinkedIn 프로필을 가져오지 못했어요. 다시 시도해주세요.');}
        setLinkedinProgress(attempt > 19 ? '프로필을 계속 확인하고 있어요. 화면을 나가도 나중에 진행 상태를 다시 확인할 수 있어요.' : '프로필을 가져와 관심사 후보를 만들고 있어요. 잠시만 기다려주세요.');
        rememberLinkedInJob(result);
        await waitForLinkedInPoll(controller.signal);
      }
      if (!controller.signal.aborted && generation === accountGeneration.current && auth === session.current) setLinkedinProgress('처리가 계속 진행 중이에요. 아래 버튼으로 진행 상태를 다시 확인해주세요.');
    } catch (e) {
      if (!controller.signal.aborted && mounted.current && generation === accountGeneration.current && auth === session.current) setError(e instanceof Error ? e.message : 'LinkedIn 프로필을 확인하지 못했어요.');
    } finally {
      if (generation === accountGeneration.current && auth === session.current) {
        if (linkedinOperation.current === controller) linkedinOperation.current = null;
        linkedinBusyRef.current = false;
        if (mounted.current) setLinkedinBusy(false);
      }
    }
  }
  async function startLinkedInImport() {
    if (linkedinStartRef.current || linkedinBusyRef.current || !linkedinUrl.trim()) return;
    const generation = accountGeneration.current, auth = session.current;
    linkedinStartRef.current = true;
    const controller = new AbortController(); linkedinOperation.current?.abort(); linkedinOperation.current = controller;
    setLinkedinBusy(true); setError(''); setLinkedinCandidates([]); setLinkedinSelected([]);
    setLinkedinProgress('LinkedIn 프로필 가져오기를 시작하고 있어요.');
    try {
      const job = await serviceAction<LinkedInImportJob>(token, 'startLinkedInImport', {url: linkedinUrl.trim()}, controller.signal);
      if (controller.signal.aborted || generation !== accountGeneration.current || auth !== session.current) return;
      setLinkedinJob(job); setLinkedinUrl(job.url); rememberLinkedInJob(job);
      setLinkedinBusy(false);
      await pollLinkedInJob(job, controller);
    } catch (e) {
      if (!controller.signal.aborted && mounted.current && generation === accountGeneration.current && auth === session.current) setError(e instanceof Error ? e.message : 'LinkedIn 프로필 가져오기를 시작하지 못했어요.');
      if (generation === accountGeneration.current && auth === session.current) {
        if (linkedinOperation.current === controller) linkedinOperation.current = null;
        if (mounted.current) setLinkedinBusy(false);
      }
    } finally {if (generation === accountGeneration.current && auth === session.current) linkedinStartRef.current = false;}
  }
  async function saveLinkedInCandidates() {
    if (!linkedinJob || linkedinJob.status !== 'ready' || !linkedinSelected.length) return;
    await run(async () => {
      const generation = accountGeneration.current, auth = session.current;
      const result = await serviceAction<{count: number; summary: string; interests: Interest[]}>(token, 'saveLinkedInImport', {jobId: linkedinJob.jobId, selectedIds: linkedinSelected}, accountLifecycle.current?.signal);
      if (generation !== accountGeneration.current || auth !== session.current) return;
      await load();
      if (generation !== accountGeneration.current || auth !== session.current) return;
      setLinkedinCandidates([]); setLinkedinSelected([]); setLinkedinJob(null); setLinkedinProgress(''); forgetLinkedInJob();
      setNotice(result.summary || `${result.count}개의 관심사를 비공개로 저장했어요.`);
    });
  }

  async function load(auth = session.current, selectedRoom = roomRef.current, signal = accountLifecycle.current?.signal) {
    const version = ++loadVersion.current;
    const next = await getServiceState(auth, selectedRoom, signal);
    if (!mounted.current || signal?.aborted || auth !== session.current || version !== loadVersion.current) return next;
    const nextIdentity = next.account?.username || '';
    if (nextIdentity && accountIdentity.current && nextIdentity !== accountIdentity.current) resetAccountState();
    if (nextIdentity) accountIdentity.current = nextIdentity;
    setData(next);
    if (auth && !next.account) await expireSession();
    return next;
  }
  function editProfile(profile = data.me) {
    setDraft(profile ? {...profile, interests: profile.interests.map(t => ({...t}))} : {...blankProfile, instagramHandle: data.account?.instagramHandle || '', linkedinHandle: data.account?.linkedinHandle || ''});
    setProfileConflict(null); setProfileConflictDetected(false); setInput(''); setQuickText(''); setCandidates([]); setDeleteConfirm(false); navigate('profile-edit', '마이');
  }
  function readInvite(url: string) {
    try {
      const params = Linking.parse(url).queryParams;
      const kind = typeof params?.room === 'string' ? 'room' : typeof params?.profile === 'string' ? 'profile' : null;
      if (kind && mounted.current) {pendingInvite.current = {kind, id: String(params?.[kind])}; setInviteVersion(version => version + 1);}
    } catch {}
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); lifecycle.current = controller; accountLifecycle.current = new AbortController();
    Linking.getInitialURL().then(url => {if (url) readInvite(url);}).catch(() => {});
    const subscription = Linking.addEventListener('url', event => {readInvite(event.url); if (mounted.current) setNotice('초대 링크를 받았어요.');});
    if (Platform.OS === 'web') readInvite(window.location.href);
    tokenRead().then(async saved => {if (controller.signal.aborted) return; session.current = saved || ''; setToken(saved || ''); await load(saved || '', undefined, controller.signal);})
      .catch(e => {if (!controller.signal.aborted) setError(e.message || '서버에 연결하지 못했어요.');})
      .finally(() => {if (!controller.signal.aborted) setBooting(false);});
    const focus = () => {if (session.current && !busyRef.current) load().catch(() => {});};
    if (Platform.OS === 'web') window.addEventListener('focus', focus);
    return () => {mounted.current = false; controller.abort(); accountLifecycle.current?.abort(); operation.current?.abort(); linkedinOperation.current?.abort(); youtubeOperation.current?.abort(); subscription.remove(); if (Platform.OS === 'web') window.removeEventListener('focus', focus);};
  }, []);
  useEffect(() => {
    const account = data.account?.username;
    if (!account || linkedinAccountRef.current === account) return;
    linkedinOperation.current?.abort();
    if (Platform.OS === 'web') {
      globalThis.localStorage?.setItem(linkedInAccountKey, account);
    }
    linkedinAccountRef.current = account;
    setLinkedinJob(null); setLinkedinCandidates([]); setLinkedinSelected([]); setLinkedinProgress(''); setLinkedinManualOpen(false);
    let restored = false;
    if (Platform.OS === 'web') {
      const key = `${linkedInJobPrefix}${account}`;
      try {
        const saved = JSON.parse(globalThis.localStorage?.getItem(key) || 'null') as {jobId?: string; url?: string; startedAt?: number} | null;
        if (saved?.jobId && saved.url && saved.startedAt && Date.now() - saved.startedAt < 24 * 60 * 60 * 1000) {
          setLinkedinJob({jobId: saved.jobId, url: saved.url, status: 'pending'}); setLinkedinUrl(saved.url);
          setLinkedinProgress('이전에 시작한 프로필 가져오기의 진행 상태를 확인할 수 있어요.'); restored = true;
        } else if (saved) globalThis.localStorage?.removeItem(key);
      } catch {globalThis.localStorage?.removeItem(key);}
    }
    if (!restored) setLinkedinUrl(linkedInProfileUrl(data.me?.linkedinHandle || data.account?.linkedinHandle));
  }, [data.account?.username]);
  useEffect(() => {
    const account = data.account?.username;
    if (Platform.OS === 'web' || page !== 'linkedin' || !account || !token || linkedinJob || linkedinStartRef.current) return;
    const controller = new AbortController();
    linkedinOperation.current = controller;
    setLinkedinBusy(true);
    serviceAction<{job: LinkedInImportJob | null}>(token, 'getLinkedInImport', {}, controller.signal)
      .then(({job}) => {
        if (!job || controller.signal.aborted || !mounted.current || linkedinAccountRef.current !== account) return;
        setLinkedinJob(job); setLinkedinUrl(job.url);
        if (job.status === 'ready') {
          const rows = (job.candidates || []).slice(0, 5).map(item => ({...item, preference: 'explore' as const, shared: false}));
          setLinkedinCandidates(rows); setLinkedinSelected(rows.map(item => item.id));
          setLinkedinProgress(`${rows.length}개의 관심사 후보를 복원했어요. 저장할 항목을 골라주세요.`);
        } else setLinkedinProgress('이전에 시작한 프로필 가져오기의 진행 상태를 확인하고 있어요.');
      })
      .catch(e => {if (!controller.signal.aborted && mounted.current) setError(e instanceof Error ? e.message : 'LinkedIn 진행 상태를 복원하지 못했어요.');})
      .finally(() => {
        if (linkedinOperation.current === controller) linkedinOperation.current = null;
        if (mounted.current && linkedinAccountRef.current === account) setLinkedinBusy(false);
      });
    return () => {controller.abort();};
  }, [page, data.account?.username, token, linkedinJob?.jobId]);
  useEffect(() => {
    if (page === 'linkedin' && linkedinJob?.status === 'pending' && token && !linkedinBusyRef.current) void pollLinkedInJob(linkedinJob);
  }, [page, linkedinJob?.jobId, token]);
  useEffect(() => {
    if (!data.account || !data.me) return;
    const invite = pendingInvite.current;
    if (invite) {pendingInvite.current = null; setCode(invite.id); setPreview(null); navigate(invite.kind === 'room' ? 'room-join' : 'friend-add', invite.kind === 'room' ? '그룹' : '친구');}
  }, [data.account, data.me, inviteVersion]);
  useEffect(() => {scroll.current?.scrollTo({y: 0, animated: false});}, [page, authMode]);
  useEffect(() => {if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer);}, [notice]);
  useEffect(() => {
    const available = new Set((data.sources?.youtube.channels || []).map(channel => channel.id));
    setYoutubeChannelIds(selected => selected.filter(id => available.has(id)));
  }, [data.sources?.youtube.channels]);
  useEffect(() => {
    const input = JSON.stringify(data.me?.interests);
    if (personalInput.current !== undefined && personalInput.current !== input && page === 'analysis' && returnPage === 'my') {
      navigate('my'); setNotice('나의 관심사가 바뀌었어요. 다시 분석해주세요.');
    }
    personalInput.current = input; setPersonal([]);
  }, [JSON.stringify(data.me?.interests)]);
  useEffect(() => {
    if (page === 'friend-detail' && preview) {
      const current = data.friends.find(p => p.id === preview.id);
      if (!current) {setPreview(null); navigate('friends'); setNotice('친구 연결이 바뀌었어요. 목록을 다시 확인해주세요.');}
      else if (JSON.stringify(current) !== JSON.stringify(preview)) setPreview(current);
    }
    if (commonPeople.length && ['common', 'common-detail', 'analysis'].includes(page) && ['friends', 'friend-detail', 'room'].includes(returnPage)) {
      const available = returnPage === 'room' ? data.selectedRoom?.members || [] : [...(data.me ? [data.me] : []), ...data.friends];
      const current = available.filter(p => commonPeople.some(old => old.id === p.id));
      if (sharedStamp(current) !== sharedStamp(commonPeople)) {setMatches([]); setCommonPeople([]); navigate(returnPage); setNotice('관심사나 참가자가 바뀌었어요. 다시 비교해주세요.');}
    }
    if (groupPeople.length && (['group-result', 'table-detail'].includes(page) || (page === 'analysis' && returnPage === 'conditions'))) {
      const current = (data.selectedRoom?.members || []).filter(p => groupPeople.some(old => old.id === p.id));
      if (sharedStamp(current) !== sharedStamp(groupPeople)) {setPlans([]); setGroupPeople([]); navigate('room'); setNotice('모임 참가자나 공유 관심사가 바뀌었어요. 편성을 다시 확인해주세요.');}
    }
  }, [data, page]);

  function navigate(next: Page, nextTab?: Tab) {
    operation.current?.abort(); operation.current = null;
    if (page === 'linkedin' && next !== 'linkedin') linkedinOperation.current?.abort();
    if (page === 'youtube' && next !== 'youtube') {
      const activeYoutubeOperation = youtubeOperation.current;
      youtubeOperation.current = null; activeYoutubeOperation?.abort(); setYoutubeAnalyzing(false);
      setYoutubeFeedback(current => current?.kind === 'progress' ? null : current);
    }
    if (nextTab) setTab(nextTab);
    setError(''); setPage(next);
  }
  function switchTab(next: Tab) {
    setSearch(''); setCode(''); setPreview(null);
    if (next === '그룹') {roomRef.current = undefined; setRoomId(undefined);}
    navigate(next === '친구' ? 'friends' : next === '그룹' ? 'groups' : 'my', next);
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    const generation = accountGeneration.current;
    busyRef.current = true; setBusy(true); setError('');
    const activeSignal = operation.current?.signal;
    try {await action();} catch (e) {
      if (mounted.current && generation === accountGeneration.current && !activeSignal?.aborted) {
        if (e instanceof ServiceError && e.status === 401 && session.current) {
          await expireSession();
        } else setError(e instanceof Error ? e.message : '요청을 처리하지 못했어요.');
      }
    }
    finally {if (generation === accountGeneration.current) {busyRef.current = false; if (mounted.current) setBusy(false);}}
  }
  async function authenticate() {
    await run(async () => {
      const result = await serviceAction<{token: string}>('', authMode, {username: username.trim(), password, ...(authMode === 'register' ? {confirmPassword: confirmation} : {})}, lifecycle.current?.signal);
      resetAccountState(); await tokenSave(result.token); session.current = result.token; setToken(result.token);
      const next = await load(result.token, undefined);
      setPassword(''); setConfirmation('');
      if (!next.me) {setDraft({...blankProfile, instagramHandle: next.account?.instagramHandle || '', linkedinHandle: next.account?.linkedinHandle || ''}); navigate('profile-edit', '마이');}
      else navigate('friends', '친구');
    });
  }
  async function logout() {
    await run(async () => {
      try {await serviceAction(token, 'logout', {}, accountLifecycle.current?.signal);} catch {}
      resetAccountState(); accountIdentity.current = ''; session.current = ''; setToken(''); await tokenClear();
    });
  }
  async function saveProfile() {
    await run(async () => {
      const generation = accountGeneration.current, auth = session.current;
      try {
        await serviceAction<{id: string; version: string}>(token, 'saveProfile', {...draft, version: draft.version ?? null}, accountLifecycle.current?.signal);
      } catch (e) {
        if (!(e instanceof ServiceError) || e.status !== 409) throw e;
        if (generation !== accountGeneration.current || auth !== session.current) return;
        const latest = await load();
        if (generation !== accountGeneration.current || auth !== session.current) return;
        setProfileConflict(latest.me); setProfileConflictDetected(true);
        setError('다른 곳에서 프로필이 변경됐어요. 현재 편집 내용은 그대로 두었습니다. 최신 프로필을 불러오면 현재 편집 내용이 교체됩니다.');
        return;
      }
      if (generation !== accountGeneration.current || auth !== session.current) return;
      setProfileConflict(null); setProfileConflictDetected(false); await load();
      if (generation !== accountGeneration.current || auth !== session.current) return;
      navigate('my', '마이'); setNotice('프로필을 저장했어요.');
    });
  }
  async function extractYouTubeInterests() {
    if (youtubeOperation.current || youtubeAnalyzing || youtubeChannelIds.length < 1 || youtubeChannelIds.length > 5) return;
    const generation = accountGeneration.current, auth = session.current, selectedChannelIds = [...youtubeChannelIds];
    const controller = new AbortController(), accountSignal = accountLifecycle.current?.signal;
    let timedOut = false;
    const abortForAccount = () => controller.abort();
    accountSignal?.addEventListener('abort', abortForAccount, {once: true});
    const timeout = setTimeout(() => {timedOut = true; controller.abort();}, youtubeAnalysisTimeoutMs);
    youtubeOperation.current = controller; setYoutubeAnalyzing(true); setError('');
    setYoutubeFeedback({kind: 'progress', message: '선택한 채널에서 키워드를 만들고 있어요. 최대 1분 정도 걸릴 수 있어요.', labels: []});
    try {
      const result = await serviceAction<{count: number; summary: string; labels?: string[]; interests?: Interest[]; fallback?: boolean}>(auth, 'extractYouTubeInterests', {channelIds: selectedChannelIds}, controller.signal);
      if (!mounted.current || accountSignal?.aborted || controller.signal.aborted || generation !== accountGeneration.current || auth !== session.current) return;
      const returnedLabels = Array.isArray(result.labels) ? result.labels : result.interests?.filter(item => item.source?.kind === 'youtube').map(item => item.label) || [];
      const labels = [...new Set(returnedLabels.map(label => label.trim()).filter(Boolean))];
      if (!labels.length) throw new Error('키워드를 만들지 못했어요. 채널을 다시 선택해 분석해주세요.');
      try {
        await load(auth, roomRef.current, controller.signal);
      } catch (refreshError) {
        if (!mounted.current || accountSignal?.aborted || generation !== accountGeneration.current || auth !== session.current || (controller.signal.aborted && !timedOut)) return;
        if (refreshError instanceof ServiceError && refreshError.status === 401 && session.current) {await expireSession(); return;}
        setYoutubeChannelIds([]);
        setYoutubeFeedback({kind: 'success', message: `${result.summary || `${labels.length}개의 키워드를 저장했어요.`} 최신 프로필을 다시 불러오지 못했어요. 새로고침해서 확인해주세요.`, labels});
        return;
      }
      if (!mounted.current || accountSignal?.aborted || controller.signal.aborted || generation !== accountGeneration.current || auth !== session.current) return;
      setYoutubeChannelIds([]);
      setYoutubeFeedback({kind: 'success', message: result.summary || `${labels.length}개의 키워드를 확인했어요.`, labels});
    } catch (e) {
      if (!mounted.current || accountSignal?.aborted || generation !== accountGeneration.current || auth !== session.current || (!timedOut && controller.signal.aborted)) return;
      if (e instanceof ServiceError && e.status === 401 && session.current) await expireSession();
      else setYoutubeFeedback({kind: 'error', message: timedOut ? '분석 시간이 길어져 중단했어요. 선택한 채널을 유지했으니 다시 시도해주세요.' : e instanceof Error ? e.message : '채널 분석을 완료하지 못했어요. 다시 시도해주세요.', labels: []});
    } finally {
      clearTimeout(timeout); accountSignal?.removeEventListener('abort', abortForAccount);
      if (youtubeOperation.current === controller) {
        youtubeOperation.current = null;
        if (mounted.current && generation === accountGeneration.current && auth === session.current) setYoutubeAnalyzing(false);
      }
    }
  }
  function addInterest(interest: Interest) {
    if (draft.interests.length >= 100) {setError('관심사는 최대 100개까지 등록할 수 있어요.'); return;}
    if (draft.interests.some(t => t.category === interest.category && canonical(t.label) === canonical(interest.label))) {setError('이미 등록한 관심사예요. 기존 항목에서 선호를 바꿔주세요.'); return;}
    setDraft({...draft, interests: [...draft.interests, {...interest, shared: false}]}); setInput(''); setError('');
  }
  function patchInterest(id: string, patch: Partial<Interest>) {setDraft({...draft, interests: draft.interests.map(t => t.id === id ? {...t, ...patch} : t)});}
  async function editAvatar() {
    await run(async () => {
      const generation = accountGeneration.current, auth = session.current;
      if (Platform.OS === 'web') {const avatar = await chooseAvatar(); if (avatar && generation === accountGeneration.current && auth === session.current) setDraft({...draft, avatar}); return;}
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync(); if (!permission.granted) throw new Error('사진 접근 권한이 필요해요.');
      if (generation !== accountGeneration.current || auth !== session.current) return;
      const result = await ImagePicker.launchImageLibraryAsync({mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: .8}); if (result.canceled) return;
      const photo = await manipulateAsync(result.assets[0].uri, [{resize: {width: 256, height: 256}}], {compress: .75, format: SaveFormat.JPEG, base64: true});
      if (photo.base64 && generation === accountGeneration.current && auth === session.current) setDraft({...draft, avatar: `data:image/jpeg;base64,${photo.base64}`});
    });
  }
  async function extract(kind: 'taste' | 'linkedin') {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    await run(async () => {
      let rows: Interest[];
      if (kind === 'linkedin') rows = (await serviceAction<{candidates: Interest[]}>(token, 'previewLinkedInText', {text: quickText}, controller.signal)).candidates.map(t => ({...t, preference}));
      else if (Platform.OS === 'web') rows = (await browserTaste(quickText, preference, setProgress, controller.signal)).map(t => ({id: newInterestId(), label: t.label, category: t.category, preference, shared: false}));
      else rows = (await serviceAction<{candidates: Interest[]}>(token, 'parseText', {text: quickText, preference}, controller.signal)).candidates;
      if (!controller.signal.aborted) {setCandidates(rows); setNotice('후보를 확인하고 원하는 항목만 추가해주세요. 저장 전까지 서버에 반영되지 않아요.');}
    });
    if (operation.current === controller) operation.current = null;
  }
  async function openRoom(id: string) {
    await run(async () => {
      const next = await load(token, id); if (!next.selectedRoom) throw new Error('모임 참여 권한을 확인해주세요.');
      roomRef.current = id; setRoomId(id); setParticipantIds([]); navigate('room', '그룹');
    });
  }
  async function createOrJoinRoom(join: boolean) {
    await run(async () => {
      const result = await serviceAction<{id: string}>(token, join ? 'joinRoom' : 'createRoom', join ? {id: codeFrom(code, 'room')} : {name: roomName.trim()}, accountLifecycle.current?.signal);
      const next = await load(token, result.id); if (!next.selectedRoom) throw new Error('모임을 불러오지 못했어요.');
      roomRef.current = result.id; setRoomId(result.id); setRoomName(''); navigate('room', '그룹'); setNotice(join ? '모임에 참여했어요.' : '모임을 만들었어요. 초대 링크로 참가자를 모아보세요.');
    });
  }
  function beginGroup() {
    if (!room) {navigate('room-create', '그룹'); return;}
    const defaultParticipants = room.isDemo
      ? room.members.filter(person => person.isDemo && person.id !== data.me?.id).slice(0, 30)
      : room.members.slice(0, 30);
    setParticipantIds(defaultParticipants.map(p => p.id)); setTableSize(4); setUseAI(false); setSavedPlan(false); setPlans([]); setSearch(''); navigate('participants', '그룹');
  }
  async function analyzeCommon(people = chosenFriends, discoverBridge = useBridge) {
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    const publicPeople = people.map(p => ({...p, interests: p.interests.filter(t => t.shared)}));
    const origin = page === 'common' ? returnPage : page; setReturnPage(origin); setCommonPeople(publicPeople); setMatches([]); setBridgeStatus(''); setBridgeMessage(''); setOnlyAll(false); setFilter('전체'); setProgress('공유한 관심사의 공통점을 비교하고 있어요'); setPage('analysis');
    try {
      let result = findMatches(publicPeople), analyzedPeople = publicPeople;
      if (discoverBridge) {
        setProgress('공통 관심사를 찾고, 부족하면 서로 다른 관심사를 연결할 주제를 검증하고 있어요');
        const response = await serviceAction<{matches: Match[]; people: Profile[]; bridgeStatus: string; bridgeMessage?: string}>(token, 'analyze', {profileIds: publicPeople.map(p => p.id), ...(roomId && (page === 'room' || (page === 'common' && returnPage === 'room')) ? {room: roomId} : {}), useAI, useBridge: discoverBridge}, controller.signal);
        result = response.matches; analyzedPeople = response.people;
        if (!controller.signal.aborted && mounted.current) {setBridgeStatus(response.bridgeStatus); setBridgeMessage(response.bridgeMessage || '');}
      } else {
        if (useAI) result = eligibleMatches([...result, ...await browserSemantic(publicPeople, setProgress, controller.signal)], publicPeople);
        result = rankConversationTopics(result, [], publicPeople);
      }
      if (controller.signal.aborted || !mounted.current) return;
      setCommonPeople(analyzedPeople); setMatches(result); setPage('common');
    } catch (e) {if (!controller.signal.aborted && mounted.current) {setPage(origin); setError(e instanceof Error ? e.message : '분석에 실패했어요.');}}
    finally {if (operation.current === controller) operation.current = null;}
  }
  async function analyzeGroups() {
    if (!roomId) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setReturnPage('conditions'); setProgress('모든 참가자를 한 번씩 배정할 편성안을 계산하고 있어요'); setPage('analysis'); setGroupPeople(selectedPeople); setSavedPlan(false); setGroupBridgeTopics([]);
    try {
      const result = await serviceAction<{plans: GroupPlan[]; bridgeTopics?: Match[]; bridgeStatus?: string; bridgeMessage?: string}>(token, 'optimizeGroups', {room: roomId, selected: participantIds, size: tableSize, useAI, useBridge}, controller.signal);
      if (controller.signal.aborted || !mounted.current) return;
      if (!result.plans.length) throw new Error('편성안을 찾지 못했어요. 참가자와 조건을 확인해주세요.');
      setGroupBridgeTopics(result.bridgeTopics || []); if (result.bridgeMessage) setNotice(result.bridgeMessage); else if (useBridge && result.bridgeStatus === 'none') setNotice('모두의 관심사에 충분한 근거가 있는 연결 주제를 찾지 못했어요. 공유 관심사를 기준으로 편성했어요.'); setPlans(result.plans.map(plan => toDemoPlan(plan, selectedPeople))); setPlanIndex(0); setPage('group-result');
    } catch (e) {if (!controller.signal.aborted && mounted.current) {setPage('conditions'); setError(e instanceof Error ? e.message : '편성에 실패했어요.');}}
    finally {if (operation.current === controller) operation.current = null;}
  }
  async function confirmPlan() {
    if (!activePlan || !roomId) return;
    await run(async () => {await serviceAction(token, 'saveRoomPlan', {room: roomId, plan: {size: tableSize, selected: participantIds, groups: activePlan.groups.map(g => g.memberIds), unassigned: activePlan.unassigned || [], ...(groupBridgeTopics.length ? {bridgeTopics: groupBridgeTopics.filter(topic => activePlan.groups.some(group => rankInterests([topic],groupPeople.filter(person => group.memberIds.includes(person.id))).length > 0))} : {})}}, accountLifecycle.current?.signal); await load(); navigate('room', '그룹'); setNotice('편성을 확정했어요. 모든 참가자가 모임에서 확인할 수 있어요.');});
  }
  function openConfirmed() {
    if (!room?.plan) return;
    const people = room.members.filter(p => room.plan!.selected.includes(p.id)), base = [...findMatches(people), ...(room.plan.bridgeTopics || [])];
    const groups = room.plan.groups.map(ids => {const metrics = scoreGroup(people, base, ids); return {ids, score: metrics.utility, metrics, interests: rankInterests(base, people.filter(p => ids.includes(p.id))).slice(0, 3)};});
    const scores = groups.map(g => g.score * 100);
    const plan: GroupPlan = {mode: 'cohesion', groups, unassigned: room.plan.unassigned, score: scores.reduce((a, b) => a + b, 0) / Math.max(1, scores.length), minScore: Math.min(...scores), range: Math.max(...scores) - Math.min(...scores), algorithm: 'saved'};
    setPlans([toDemoPlan(plan, people)]); setPlanIndex(0); setGroupPeople(people); setSavedPlan(true); navigate('group-result', '그룹');
  }
  async function analyzePersonal() {
    if (!data.me) return;
    const controller = new AbortController(); operation.current?.abort(); operation.current = controller;
    setReturnPage('my'); setProgress('나의 관심사를 실제 AI 모델로 분석하고 있어요'); setPage('analysis');
    try {const topics = await analyzePersonalInterests(data.me, setProgress, controller.signal); if (!controller.signal.aborted && mounted.current) {setPersonal(topics); setPage('my-interests');}}
    catch (e) {if (!controller.signal.aborted && mounted.current) {setPage('my'); setError(e instanceof Error ? e.message : '분석에 실패했어요.');}}
    finally {if (operation.current === controller) operation.current = null;}
  }
  function startShare(kind: 'profile' | 'room') {
    const id = kind === 'profile' ? data.me?.id : roomId; if (!id) return;
    const url = Platform.OS === 'web' ? `${window.location.origin}/?${kind}=${encodeURIComponent(id)}` : Linking.createURL('/', {queryParams: {[kind]: id}});
    setShare({title: kind === 'profile' ? '내 프로필 공유' : `${room?.name || '모임'} 초대`, url, code: id}); navigate('share', kind === 'profile' ? '마이' : '그룹');
  }
  function back() {
    const parent: Partial<Record<Page, Page>> = {'friend-add': 'friends', 'friend-detail': 'friends', common: returnPage, 'common-detail': 'common', 'room-create': 'groups', 'room-join': 'groups', room: 'groups', participants: 'room', conditions: 'participants', 'group-result': savedPlan ? 'room' : 'conditions', 'table-detail': 'group-result', 'profile-edit': 'my', share: tab === '그룹' ? 'room' : 'my', youtube: 'my', linkedin: 'my', 'my-interests': 'my', 'my-interest-detail': 'my-interests', analysis: returnPage};
    navigate(parent[page] || 'friends');
  }
  function sourceStatus(source?: SourceState) {
    return source?.status === 'ok' ? '가져옴' : source?.status === 'partial' ? '일부 가져옴' : source?.status === 'error' ? '다시 연결 필요' : '연동 전';
  }
  function sourceSummary(source: SourceState | undefined) {
    if (!source || ['never', 'disconnected'].includes(source.status)) return <Text style={s.description}>아직 가져온 데이터가 없어요.</Text>;
    return <Card><View style={s.between}><Text style={s.label}>가져온 데이터</Text><Tag>{sourceStatus(source)}</Tag></View><View style={[s.metrics, {marginVertical: 18}]}><Metric label="데이터" value={source.itemCount} suffix="건"/><Metric label="새 관심사" value={source.candidateCount} suffix="개"/></View>{source.samples.map((sample, i) => <Text key={i} style={s.description}>{sample}</Text>)}{source.updated && <Text style={[s.small, {marginTop: 10}]}>{new Date(source.updated).toLocaleString('ko-KR')}</Text>}{source.status === 'partial' && <Text style={s.small}>일부 항목을 가져오지 못했어요. 다시 연결하면 재시도할 수 있어요.</Text>}{source.status === 'error' && <Text style={s.small}>가져오기에 실패했어요. 연결을 다시 시도해주세요.</Text>}</Card>;
  }

  function searchField(label = '이름 검색') {
    return <View style={s.search}><Icon name="search-outline" color="#71717A"/><TextInput accessibilityLabel={label} style={s.searchInput} value={search} onChangeText={setSearch} placeholder="이름으로 검색"/>{!!search && <Pressable accessibilityRole="button" accessibilityLabel="검색어 지우기" onPress={() => setSearch('')}><Icon name="close-circle" size={18}/></Pressable>}</View>;
  }
  function personCards(people: Profile[], ids: string[], onToggle: (id: string) => void, showProfile = false) {
    const visible = people.filter(p => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
    return <View>{visible.length === 0 && <Empty icon="search-outline" title="표시할 사람이 없어요" text="참가자나 검색어를 확인해주세요."/>}{visible.map(p => <Pressable key={p.id} accessibilityRole="checkbox" accessibilityState={{checked: ids.includes(p.id)}} aria-checked={ids.includes(p.id)} accessibilityLabel={`${p.name}${p.isDemo ? ' 예시 프로필' : ''} 선택`} onPress={() => onToggle(p.id)} style={[s.personCard, ids.includes(p.id) && s.personCardSelected]}><Avatar profile={toDemoProfile(p)}/><View style={s.flex}><View style={s.row}><Text style={s.personName}>{p.name}</Text>{p.id === data.me?.id && <Tag>나</Tag>}{p.isDemo && <Tag>예시</Tag>}</View><Text style={s.personInterests} numberOfLines={1}>{positiveInterests(p).slice(0, 3).map(t => t.label).join(' · ') || '공유한 관심사가 없어요'}</Text></View><View style={[s.check, ids.includes(p.id) && s.checkSelected]}>{ids.includes(p.id) && <Icon name="checkmark" size={15} color="white"/>}</View>{showProfile && <Pressable accessibilityRole="button" accessibilityLabel={`${p.name} 프로필 보기`} onPress={event => {event.stopPropagation(); setPreview(p); setRemoveConfirm(false); navigate('friend-detail');}} style={{padding: 10}}><Icon name="chevron-forward" size={18}/></Pressable>}</Pressable>)}</View>;
  }
  function bridgeChoice() {
    return <Choice checked={useBridge} label="부족한 대화 주제 자동으로 찾기" detail="모두에게 직접 연결되는 주제가 3개보다 적으면 연결 주제를 찾아 Top 3에 포함해요. 공유한 대표 긍정 관심사와 공개 근거만 외부 AI에 전달해요. 끄면 직접 공통점만 사용해요." onPress={() => setUseBridge(!useBridge)}/>;
  }
  const topicTypeLabel = (item: CommonInterest) => item.matchType === 'Bridge' ? '연결 주제' : '공통 관심사';
  function evidenceCards(item: CommonInterest, people: Profile[]) {
    return item.evidence.map(e => {const profile = people.find(p => p.id === e.profileId); return <Card key={e.profileId}><View style={[s.row, {marginBottom: 12}]}><Avatar profile={toDemoProfile(profile || {...blankProfile, id: e.profileId, name: e.profileName})} size={35}/><Text style={[s.label, s.flex]}>{e.profileName}</Text>{profile?.isDemo && <Tag>예시</Tag>}</View><View style={[s.tags, {marginBottom: 14}]}>{e.interestLabels.map(label => <Tag key={label}>{label}</Tag>)}</View>{e.explanation && <Text style={[s.description, {marginBottom: 12}]}>{e.explanation}</Text>}{item.matchType === 'Bridge' && <Text style={[s.small, {marginBottom: 12}]}>관심사 관련도 · {e.score}점</Text>}<SourceList sources={e.sources} example={profile?.isDemo}/></Card>;});
  }
  function shareToggle(label: string, value: boolean, onChange: (value: boolean) => void, detail?: string) {
    return <View style={[s.between, {paddingVertical: 10}]}><View style={s.flex}><Text style={s.label}>{label}</Text>{detail && <Text style={s.small}>{detail}</Text>}</View><Switch accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{false: '#DADADD', true: '#18181B'}} thumbColor="white"/></View>;
  }
  function profileEditor() {
    return <><Heading eyebrow="MY PROFILE" title={data.me ? '나의 프로필' : '어떤 이야기를 좋아하세요?'} description="관심사마다 선호와 공유 여부를 정해주세요. 새로 추가한 관심사는 기본 비공개예요."/><View style={{alignItems: 'center', gap: 12, marginVertical: 12}}><Avatar profile={toDemoProfile({...draft, name: draft.name || '나'})} size={88}/><Button compact secondary disabled={busy} onPress={editAvatar}>사진 선택</Button>{!!draft.avatar && <Pressable accessibilityRole="button" onPress={() => setDraft({...draft, avatar: ''})}><Text style={s.link}>사진 지우기</Text></Pressable>}</View><Section title="이름"><TextInput accessibilityLabel="프로필 이름" style={s.input} value={draft.name} onChangeText={name => setDraft({...draft, name})} maxLength={30} placeholder="이름을 입력해주세요"/></Section><Section title="한 줄 소개"><TextInput accessibilityLabel="한 줄 소개" style={s.input} value={draft.bio} onChangeText={bio => setDraft({...draft, bio})} maxLength={160} placeholder="나를 소개해주세요"/></Section>
      <Section title="관심사 추가"><ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={s.tags}>{categories.filter(c => c !== '전체').map(c => <Pressable key={c} accessibilityRole="radio" accessibilityState={{checked: category === c}} onPress={() => setCategory(c)} style={[s.tag, category === c && {backgroundColor: '#18181B'}]}><Text style={[s.tagText, category === c && {color: 'white'}]}>{c}</Text></Pressable>)}</View></ScrollView><View style={s.sizeOptions}>{(['like', 'avoid', 'explore'] as Preference[]).map(p => <Pressable key={p} accessibilityRole="radio" accessibilityState={{checked: preference === p}} onPress={() => setPreference(p)} style={[s.button, s.buttonSecondary, s.flex, preference === p && {backgroundColor: '#18181B'}]}><Text style={[s.link, preference === p && {color: 'white'}]}>{preferenceNames[p]}</Text></Pressable>)}</View><TextInput accessibilityLabel="새 관심사" style={s.input} value={input} onChangeText={setInput} placeholder="예: 재즈, 머신러닝, 러닝" maxLength={60}/><Button secondary disabled={!input.trim() || busy} onPress={() => addInterest({id: newInterestId(), label: input.trim(), category, shared: false, preference})}>관심사 추가</Button></Section>
      <Section title={`등록한 관심사 · ${draft.interests.length}개`}><Text style={s.small}>공유한 항목과 출처 근거는 공개 프로필과 모임에서 볼 수 있어요. 공유하지 않은 항목은 나만 볼 수 있어요.</Text>{draft.interests.map(t => <Card key={t.id}><View style={s.between}><View style={s.flex}><Text style={s.label}>{t.label}</Text><Text style={s.small}>{t.category} · {t.source?.label || '직접 등록'}</Text></View><Pressable accessibilityRole="button" accessibilityLabel={`${t.label} 삭제`} onPress={() => setDraft({...draft, interests: draft.interests.filter(x => x.id !== t.id)})}><Icon name="close" size={19}/></Pressable></View><View style={[s.tags, {marginTop: 12}]}>{(['like', 'avoid', 'explore'] as Preference[]).map(p => <Pressable key={p} accessibilityRole="radio" accessibilityLabel={`${t.label} ${preferenceNames[p]}`} accessibilityState={{checked: preferenceOf(t) === p}} onPress={() => patchInterest(t.id, {preference: p})} style={[s.tag, preferenceOf(t) === p && {backgroundColor: '#18181B'}]}><Text style={[s.tagText, preferenceOf(t) === p && {color: 'white'}]}>{preferenceNames[p]}</Text></Pressable>)}</View>{shareToggle(`${t.label} 공유`, t.shared, shared => patchInterest(t.id, {shared}))}</Card>)}</Section>
      <Section title="문장으로 취향 정리"><Text style={s.description}>{preferenceQuestions[preference]} 직접 쓴 문장에서 후보를 확인하고 원하는 항목만 추가해요.</Text><TextInput accessibilityLabel="취향 정리 문장" style={[s.input, {minHeight: 100, textAlignVertical: 'top'}]} multiline value={quickText} onChangeText={setQuickText} maxLength={20000} placeholder="좋아하는 것 또는 Skills: React, SQL 같은 목록을 입력해주세요"/><Button secondary disabled={busy || !quickText.trim() || quickText.length > 1000} onPress={() => extract('taste')}>AI로 후보 정리</Button><Text style={s.small}>AI 문장 정리는 1,000자까지 지원해요. 웹 첫 실행은 약 614MB 모델 다운로드가 필요해요.</Text><Button secondary disabled={busy || !quickText.trim()} onPress={() => extract('linkedin')}>LinkedIn 목록 미리보기</Button>{busy && !!progress && <Text accessibilityLiveRegion="polite" style={s.small}>{progress}</Text>}{busy && operation.current && <Button secondary onPress={() => {operation.current?.abort(); setProgress('');}}>후보 정리 중단</Button>}{candidates.map(t => <View key={t.id} style={s.between}><View style={s.flex}><Text style={s.label}>{t.label}</Text><Text style={s.small}>{t.category} · {preferenceNames[preferenceOf(t)]}</Text></View><Button compact secondary disabled={draft.interests.some(x => x.category === t.category && canonical(x.label) === canonical(t.label))} onPress={() => addInterest(t)}>추가</Button></View>)}</Section>
      <Section title="선택 프로필 링크"><TextInput accessibilityLabel="Instagram 아이디" style={s.input} value={draft.instagramHandle || ''} onChangeText={instagramHandle => setDraft({...draft, instagramHandle})} placeholder="Instagram 아이디 또는 링크" autoCapitalize="none"/>{shareToggle('Instagram 친구 공개', !!draft.instagramVisible, instagramVisible => setDraft({...draft, instagramVisible}), '서로 수락한 친구만 볼 수 있어요.')}<TextInput accessibilityLabel="LinkedIn 프로필 아이디" style={s.input} value={draft.linkedinHandle || ''} onChangeText={linkedinHandle => setDraft({...draft, linkedinHandle})} placeholder="LinkedIn 프로필 아이디 또는 링크" autoCapitalize="none"/>{shareToggle('LinkedIn 친구 공개', !!draft.linkedinVisible, linkedinVisible => setDraft({...draft, linkedinVisible}), '계정 로그인과 별개로 프로필 링크를 등록해요.')}</Section>{profileConflictDetected && <Card quiet><Text style={s.label}>최신 프로필과 편집 내용이 달라요</Text><Text style={s.description}>현재 편집 내용은 유지되어 있어요. 최신 프로필을 불러오면 지금 입력한 내용이 교체됩니다.</Text><Button secondary disabled={busy} onPress={() => {const latest = profileConflict || {...blankProfile, instagramHandle: data.account?.instagramHandle || '', linkedinHandle: data.account?.linkedinHandle || ''}; setDraft({...latest, interests: latest.interests.map(item => ({...item}))}); setProfileConflict(null); setProfileConflictDetected(false); setError(''); setCandidates([]); setInput(''); setQuickText('');}}>최신 프로필 불러오기</Button></Card>}<Button disabled={busy || !draft.name.trim()} onPress={saveProfile}>내 취향 저장</Button></>;
  }

  function renderPage() {
    if (booting) return <View style={s.empty}><ActivityIndicator color="#18181B"/><Text style={s.description}>프로필을 불러오고 있어요</Text></View>;
    if (!data.account) return <><Heading eyebrow="WELCOME TO SAI" title="대화의 시작을 찾는 사이" description="나의 관심사를 담고, 친구와 함께할 이야기를 찾아요."/><View style={s.planOptions}>{(['login', 'register'] as const).map(mode => <Pressable key={mode} accessibilityRole="tab" accessibilityState={{selected: authMode === mode}} onPress={() => {setAuthMode(mode); setError('');}} style={[s.button, s.flex, mode !== authMode && s.buttonSecondary]}><Text style={[s.buttonText, mode !== authMode && {color: '#18181B'}]}>{mode === 'login' ? '로그인' : '회원가입'}</Text></Pressable>)}</View><Section title="아이디"><TextInput accessibilityLabel="아이디" autoCapitalize="none" autoCorrect={false} textContentType="username" style={s.input} value={username} onChangeText={setUsername} maxLength={30} placeholder="영문·숫자·밑줄 3~30자"/></Section><Section title="비밀번호"><TextInput accessibilityLabel="비밀번호" secureTextEntry textContentType={authMode === 'register' ? 'newPassword' : 'password'} style={s.input} value={password} onChangeText={setPassword} maxLength={128} placeholder="12자 이상 입력해주세요"/></Section>{authMode === 'register' && <Section title="비밀번호 확인"><TextInput accessibilityLabel="비밀번호 확인" secureTextEntry textContentType="newPassword" style={s.input} value={confirmation} onChangeText={setConfirmation} maxLength={128} placeholder="비밀번호를 한 번 더 입력해주세요"/></Section>}<Button disabled={busy || !username.trim() || !password || (authMode === 'register' && !confirmation)} onPress={authenticate}>{authMode === 'login' ? '로그인하기' : '가입하고 시작하기'}</Button>{!!pendingInvite.current && <Card quiet><Text style={s.description}>로그인하고 프로필을 만들면 받은 초대 링크로 이어져요.</Text></Card>}{localDemoEnabled && <Section title="먼저 둘러보고 싶으세요?"><Button secondary disabled={busy} onPress={onExample}>예시 데이터로 체험하기</Button><Text style={s.small}>예시 프로필로 공통 관심사와 그룹 편성을 체험할 수 있어요.</Text></Section>}</>;
    if (!data.me || page === 'profile-edit') return profileEditor();
    switch (page) {
      case 'friends': return <><Heading eyebrow="FIND YOUR COMMON GROUND" title="우리 사이, 어떤 이야기?" description="친구와 나의 공유 관심사에서 함께할 이야기를 찾아요."/><Button secondary disabled={busy} onPress={() => {setCode(''); setPreview(null); navigate('friend-add');}}>+ 친구 추가</Button>{data.requests.length > 0 && <Section title={`받은 친구 요청 · ${data.requests.length}개`}>{data.requests.map(p => <Card key={p.id}><View style={s.row}><Avatar profile={toDemoProfile(p)} size={38}/><Text style={[s.label, s.flex]}>{p.name}</Text><Button compact disabled={busy} onPress={() => run(async () => {await serviceAction(token, 'acceptFriend', {id: p.id}); await load(); setNotice('친구 요청을 수락했어요.');})}>수락</Button><Pressable accessibilityRole="button" accessibilityLabel={`${p.name} 친구 요청 거절`} disabled={busy} onPress={() => run(async () => {await serviceAction(token, 'removeFriend', {id: p.id}); await load();})}><Text style={s.link}>거절</Text></Pressable></View></Card>)}</Section>}{data.sent.length > 0 && <Text style={s.small}>보낸 요청 {data.sent.length}개 · 상대가 수락하면 친구 목록에 나타나요.</Text>}{searchField()}<View style={s.between}><Text style={s.sectionTitle}>친구 <Text style={s.count}>{data.friends.length}</Text></Text><Pressable accessibilityRole="button" disabled={busy} onPress={() => run(async () => {await load();})}><Text style={s.link}>새로고침</Text></Pressable></View>{data.friends.length ? <><Choice checked={includeMe} label="나도 함께 비교" detail="나의 공개한 관심사만 사용해요." onPress={() => setIncludeMe(!includeMe)}/>{personCards(data.friends, friendIds, id => setFriendIds(friendIds.includes(id) ? friendIds.filter(x => x !== id) : [...friendIds, id]), true)}{bridgeChoice()}<Choice checked={useAI} label="AI 의미 비교도 함께 사용" detail="다르게 표현한 관심사도 비교해요. 첫 실행에 모델 약 614MB를 다운로드해요." onPress={() => setUseAI(!useAI)}/></> : <Empty icon="people-outline" title="첫 친구를 만나보세요" text="프로필 링크나 코드를 받아 친구를 추가하고, 서로 요청을 수락해주세요."/>}</>;
      case 'friend-add': return <><Heading eyebrow="MAKE A CONNECTION" title="친구를 연결해볼까요?" description="친구의 프로필 링크 또는 코드를 입력해주세요."/><TextInput accessibilityLabel="친구 프로필 링크 또는 코드" style={s.input} value={code} onChangeText={value => {setCode(value); setPreview(null);}} autoCapitalize="none" placeholder="프로필 링크 또는 코드"/><Button secondary disabled={busy || !code.trim()} onPress={() => run(async () => {setPreview(await getSharedProfile(token, codeFrom(code, 'profile')));})}>프로필 확인</Button>{preview && <Card><View style={s.row}><Avatar profile={toDemoProfile(preview)} size={56}/><View style={s.flex}><Text style={s.profileName}>{preview.name}</Text><Text style={s.description}>{preview.bio}</Text></View></View><View style={[s.tags, {marginTop: 16, marginBottom: 20}]}>{positiveInterests(preview).map(t => <Tag key={t.id}>{t.label}</Tag>)}</View><Button disabled={busy || preview.id === data.me.id || data.friends.some(p => p.id === preview.id) || data.sent.includes(preview.id)} onPress={() => run(async () => {const result = await serviceAction<{status: string}>(token, 'requestFriend', {id: preview.id}); await load(); navigate('friends'); setNotice(result.status === 'accepted' ? '이미 친구로 연결되어 있어요.' : '친구 요청을 보냈어요. 상대가 수락하면 연결돼요.');})}>{preview.id === data.me.id ? '내 프로필이에요' : data.friends.some(p => p.id === preview.id) ? '이미 친구예요' : data.sent.includes(preview.id) ? '수락을 기다리고 있어요' : '친구 요청 보내기'}</Button></Card>}<Button secondary onPress={() => startShare('profile')}>내 프로필 링크 공유</Button></>;
      case 'friend-detail': return preview && <><Heading eyebrow="FRIEND PROFILE" title={preview.name} description={preview.bio}/>{preview.isDemo && <Tag>예시 프로필</Tag>}<Avatar profile={toDemoProfile(preview)} size={72}/><Section title="공유 관심사"><View style={s.tags}>{positiveInterests(preview).map(t => <Tag key={t.id}>{t.label}</Tag>)}</View></Section>{preview.instagramHandle && <Button secondary onPress={() => Linking.openURL(`https://www.instagram.com/${preview.instagramHandle}/`)}>Instagram 프로필 열기</Button>}{preview.linkedinHandle && <Button secondary onPress={() => Linking.openURL(`https://www.linkedin.com/in/${preview.linkedinHandle}/`)}>LinkedIn 프로필 열기</Button>}{bridgeChoice()}<Button onPress={() => analyzeCommon([data.me!, preview])}>함께 이야기할 주제 보기</Button><Button secondary disabled={busy} onPress={() => setRemoveConfirm(!removeConfirm)}>친구 연결 해제</Button>{removeConfirm && <Card><Text style={s.description}>{preview.isDemo ? '예시 친구를 목록에서 제거해요. 모임의 예시 참가자는 유지돼요.' : '친구 연결을 해제할까요? 이후 다시 요청을 보내 연결할 수 있어요.'}</Text><Button secondary disabled={busy} onPress={() => run(async () => {await serviceAction(token, 'removeFriend', {id: preview.id}); setFriendIds(friendIds.filter(id => id !== preview.id)); await load(); navigate('friends'); setNotice('친구 연결을 해제했어요.');})}>연결 해제 확인</Button></Card>}</>;
      case 'common': return <><Heading eyebrow="COMMON INTERESTS" title="함께 나눌 이야기" description={`${names(commonPeople)}\n${onlyAll ? `${commonPeople.length}명 모두의` : '참가자들의'} 공유 관심사에서 찾았어요.`}/><View style={s.avatarStack}>{commonPeople.map(p => <View key={p.id} style={s.stackPerson}><Avatar profile={toDemoProfile(p)} size={42}/><Text style={s.stackName}>{p.name}</Text></View>)}</View>{bridgeMessage && <Card quiet><Text accessibilityLiveRegion="polite" style={s.description}>{bridgeMessage}</Text></Card>}<Choice checked={onlyAll} label="모두에게 연결되는 주제만" onPress={() => setOnlyAll(!onlyAll)}/><ScrollView horizontal showsHorizontalScrollIndicator={false}><View style={s.tags}>{categories.map(c => <Pressable key={c} accessibilityRole="radio" accessibilityState={{checked: filter === c}} onPress={() => setFilter(c)} style={[s.tag, filter === c && {backgroundColor: '#18181B'}]}><Text style={[s.tagText, filter === c && {color: 'white'}]}>{c}</Text></Pressable>)}</View></ScrollView>{shownMatches.length ? <Section title="함께 이야기할 주제 Top 3"><Card>{shownMatches.slice(0, 3).map((m, i) => <TopicRow key={m.id} topic={toCommonInterest(m, commonPeople)} badge={m.kind === 'bridge' ? '연결 주제' : '공통 관심사'} index={i} onPress={() => {setTopic(toCommonInterest(m, commonPeople)); navigate('common-detail');}}/>)}</Card><Text style={s.small}>점수는 공유 관심사의 연결 정도를 나타내는 참고 지표예요. 관계 성공 확률은 아니에요.</Text></Section> : <Empty title={bridgeStatus === 'none' ? '강한 공통 대화 주제를 찾기 어려워요' : '공통 주제를 찾지 못했어요'} text={bridgeStatus === 'none' ? '모두의 관심사에 충분한 근거가 있는 연결 주제를 찾지 못했어요. 관심사를 더하거나 참가자를 바꿔보세요.' : '공유한 관심사를 더하거나 참가자와 필터를 바꿔보세요. 다른 관심사 사이의 연결 주제도 찾아볼 수 있어요.'}/>}<Button secondary disabled={busy || commonPeople.length < 2} onPress={() => {setUseBridge(true); analyzeCommon(commonPeople, true);}}>{bridgeStatus ? '연결 주제 다시 찾기' : '연결 주제 찾기'}</Button><Button secondary onPress={back}>다른 사람 선택하기</Button></>;
      case 'common-detail': return topic && <><Heading eyebrow="WHY THIS TOPIC" title={topic.label} description={`${topic.members.length}/${commonPeople.length}명에게 연결된 관심사`}/><Card quiet><View style={s.between}><Text style={s.label}>연결 점수</Text><Score value={topic.score} large/></View><Text style={[s.description, {marginTop: 16}]}>{topic.reason}</Text><View style={[s.tags, {marginTop: 12}]}><Tag>{topicTypeLabel(topic)}</Tag></View>{topic.consensus !== undefined && <Text style={s.small}>함께 이야기할 관련도 · {topic.consensus}점</Text>}</Card><Section title="사용자별 근거">{evidenceCards(topic, commonPeople)}</Section></>;
      case 'groups': return <><Heading eyebrow="BETTER TOGETHER" title="대화가 잘 통하는 조합" description="모임에 참가자를 초대하고 공통 관심사와 균형을 고려해 테이블을 편성해요."/>{data.rooms.some(r => r.isDemo) && <Card quiet><Text style={s.description}>24명의 예시 참가자가 있는 모임을 기본으로 제공해요.</Text></Card>}<Button onPress={() => {setRoomName(''); navigate('room-create');}}>+ 그룹 만들기</Button><Button secondary onPress={() => {setCode(''); navigate('room-join');}}>초대 링크 / 코드로 참여</Button><Section title={`나의 모임 · ${data.rooms.length}개`}>{data.rooms.length ? data.rooms.map(r => <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.name}${r.isDemo ? ' 예시' : ''} 모임 열기`} disabled={busy} onPress={() => openRoom(r.id)} style={s.card}><View style={s.between}><View style={s.groupIcon}><Icon name="people-outline" size={23}/></View><Icon name="chevron-forward" color="#71717A"/></View><View style={s.row}><Text style={s.groupTitle}>{r.name}</Text>{r.isDemo && <Tag>예시</Tag>}</View><Text style={s.description}>{r.count}명 참여 중</Text></Pressable>) : <Empty icon="people-outline" title="첫 모임을 만들어보세요" text="모임을 만들고 초대 링크를 공유하거나, 받은 코드로 참여해주세요."/>}</Section></>;
      case 'room-create': return <><Heading eyebrow="CREATE GROUP" title="모임을 준비해볼까요?" description="모임을 만든 다음 친구들에게 초대 링크를 보내주세요."/><Section title="모임 이름"><TextInput accessibilityLabel="모임 이름" style={s.input} value={roomName} onChangeText={setRoomName} maxLength={60} placeholder="예: 동아리 OT"/></Section><Button disabled={busy || !roomName.trim()} onPress={() => createOrJoinRoom(false)}>모임 만들기</Button></>;
      case 'room-join': return <><Heading eyebrow="JOIN A GROUP" title="함께할 자리를 찾아요" description="받은 초대 링크 또는 모임 코드를 입력해주세요."/><TextInput accessibilityLabel="모임 초대 링크 또는 코드" style={s.input} value={code} onChangeText={setCode} autoCapitalize="none" placeholder="초대 링크 또는 모임 코드"/><Button disabled={busy || !code.trim()} onPress={() => createOrJoinRoom(true)}>모임 참여하기</Button></>;
      case 'room': return room ? <><Heading eyebrow="YOUR GROUP" title={room.name} description={`${room.members.length}명이 함께하고 있어요.`}/>{room.isDemo && <Card quiet><Text style={s.description}>편성을 시작하면 예시 참가자 24명이 기본 선택돼요. 내 프로필은 필요할 때 직접 추가할 수 있어요.</Text></Card>}<Button secondary onPress={() => startShare('room')}>초대 링크 / QR 공유</Button>{room.plan && <Card quiet><Text style={s.label}>확정한 편성 · {room.plan.groups.length}개 테이블</Text><Text style={[s.description, {marginVertical: 10}]}>{room.plan.selected.length - room.plan.unassigned.length}명 배정{room.plan.unassigned.length ? ` · ${room.plan.unassigned.length}명 배정 보류` : ''}</Text><Button secondary onPress={openConfirmed}>확정 편성 보기</Button></Card>}<Section title="참가자">{room.members.map(p => <View key={p.id} style={s.personCard}><Avatar profile={toDemoProfile(p)}/><View style={s.flex}><View style={s.row}><Text style={s.personName}>{p.name}{p.id === room.owner ? ' · 모임장' : ''}</Text>{p.isDemo && <Tag>예시</Tag>}</View><Text style={s.personInterests}>{positiveInterests(p).slice(0, 3).map(t => t.label).join(' · ') || '공유한 관심사가 없어요'}</Text></View></View>)}</Section>{bridgeChoice()}<Choice checked={useAI} label="AI 의미 비교도 함께 사용" detail="처음 사용하면 모델 다운로드와 실행 시간이 필요해요." onPress={() => setUseAI(!useAI)}/><Button secondary disabled={room.members.length < 2} onPress={() => analyzeCommon(room.members)}>참가자 대화 주제 보기</Button><Button disabled={room.members.length < 3} onPress={beginGroup}>모임 편성하기</Button><Button secondary disabled={busy} onPress={() => run(async () => {await serviceAction(token, 'leaveRoom', {id: room.id}); roomRef.current = undefined; setRoomId(undefined); await load(token, undefined); navigate('groups'); setNotice('모임에서 나왔어요. 초대 코드로 다시 참여할 수 있어요.');})}>모임 나가기</Button></> : <Empty title="모임을 불러오지 못했어요" text="그룹 목록에서 다시 선택해주세요."/>;
      case 'participants': return <><Heading eyebrow="CREATE GROUP · 01 / 02" title="누구와 함께할까요?" description="모임 참가자를 3~30명 선택해주세요."/>{searchField('편성 참가자 검색')}<View style={s.between}><Text style={s.label}>참가자 {room?.members.length || 0}명</Text><Pressable accessibilityRole="button" onPress={() => setParticipantIds(participantIds.length ? [] : (room?.members || []).slice(0, 30).map(p => p.id))}><Text style={s.link}>{participantIds.length ? '선택 해제' : '전체 선택'}</Text></Pressable></View>{personCards(room?.members || [], participantIds, id => {if (!participantIds.includes(id) && participantIds.length >= 30) {setError('한 번에 최대 30명을 편성할 수 있어요.'); return;} setParticipantIds(participantIds.includes(id) ? participantIds.filter(x => x !== id) : [...participantIds, id]);})}</>;
      case 'conditions': return <><Heading eyebrow="CREATE GROUP · 02 / 02" title="몇 명씩 모일까요?" description={`${room?.name} · ${selectedPeople.length}명이 함께해요.`}/><Section title="테이블당 인원"><View style={s.sizeOptions}>{[3, 4, 5].map(size => <Pressable key={size} accessibilityRole="radio" accessibilityLabel={`테이블당 ${size}명`} accessibilityState={{checked: size === tableSize}} onPress={() => setTableSize(size)} style={[s.sizeOption, size === tableSize && s.sizeActive]}><Icon name="people-outline" size={25} color={size === tableSize ? 'white' : '#18181B'}/><Text style={[s.sizeLabel, size === tableSize && {color: 'white'}]}>{size}명</Text></Pressable>)}</View><Card quiet><Text style={s.label}>{selectedPeople.length}명 / 테이블당 최대 {tableSize}명</Text><Text style={s.expectedTables}>{Math.ceil(selectedPeople.length / tableSize)}개 테이블 예상</Text><Text style={s.small}>모든 참가자를 빠짐없이 한 번씩 배정해요. 남는 인원은 가능한 테이블에 균형 있게 나눠요.</Text></Card></Section>{bridgeChoice()}<Choice checked={useAI} label="AI 의미 비교도 함께 사용" detail="서버에서 실제 의미 비교 후 CP-SAT 편성을 실행해요." onPress={() => setUseAI(!useAI)}/><Section title="선택한 참가자"><Text style={s.description}>{names(selectedPeople)}</Text></Section><Button disabled={busy || selectedPeople.length < 3} onPress={analyzeGroups}>그룹 추천하기</Button></>;
      case 'analysis': return <View style={s.analysis}><Text style={s.eyebrow}>INTEREST ANALYSIS</Text><View style={s.analysisGraphic}><Icon name="sparkles-outline" size={38}/><ActivityIndicator style={s.analysisSpinner} color="#18181B"/></View><Text style={[s.title, {textAlign: 'center'}]}>함께할 이야기를 찾고 있어요</Text><Text accessibilityLiveRegion="polite" style={[s.description, {textAlign: 'center'}]}>{progress}</Text><Text style={[s.small, {textAlign: 'center'}]}>실제 데이터와 모델로 분석해요. 처음에는 모델 준비에 시간이 걸릴 수 있어요.</Text><Button secondary onPress={back}>분석 중단</Button></View>;
      case 'group-result': return activePlan && <><Heading eyebrow={savedPlan ? 'CONFIRMED GROUP' : 'RECOMMENDED PLANS'} title={savedPlan ? '확정한 편성이에요' : '이 조합은 어때요?'} description={`${names(groupPeople)}\n${groupPeople.length}명의 테이블과 추천 근거를 확인해보세요.`}/>{!savedPlan && <View style={s.planOptions}>{plans.map((plan, i) => <Pressable key={plan.id} accessibilityRole="tab" accessibilityLabel={`추천 ${i + 1}`} accessibilityState={{selected: i === planIndex}} onPress={() => setPlanIndex(i)} style={[s.planOption, i === planIndex && s.planOptionActive]}><Text style={[s.planCaption, i === planIndex && {color: 'white'}]}>추천 {i + 1}</Text><Text style={[s.planScore, i === planIndex && {color: 'white'}]}>{Math.round(plan.score)}<Text style={s.planUnit}> 점</Text></Text></Pressable>)}</View>}<Card quiet><Text style={s.label}>{activePlan.label}</Text><View style={[s.metrics, {marginTop: 20}]}><Metric label="전체 추천 점수" value={Math.round(activePlan.score)} suffix="점"/><Metric label="최저 테이블" value={Math.round(activePlan.minGroupScore)} suffix="점"/><Metric label="테이블 간 균형" value={Math.round(activePlan.balance)} suffix="점"/></View></Card><Text style={s.small}>{savedPlan ? '확정한 배정을 표시해요. 점수와 근거는 현재 공유 관심사로 다시 계산했어요.' : `${plans.length}개의 서로 다른 편성안을 찾았어요. 실제 CP-SAT 상태와 후보 범위는 아래에 표시해요.`}</Text>{!savedPlan && <Text style={s.small}>OR-Tools CP-SAT · {activePlan.solverStatus} · {activePlan.candidateScope === 'bounded' ? '제한한 후보 범위' : '전체 후보 범위'} ({activePlan.candidateCount || 0}개)</Text>}{!!activePlan.unassigned?.length && <Card quiet><Text style={s.label}>배정 보류 · {activePlan.unassigned.length}명</Text><Text style={s.description}>{names(groupPeople.filter(p => activePlan.unassigned!.includes(p.id)))}</Text></Card>}<Section title={`${activePlan.groups.length}개의 테이블`}>{activePlan.groups.map((g, i) => <Pressable key={g.id} accessibilityRole="button" accessibilityLabel={`테이블 ${i + 1} 상세 보기`} onPress={() => {setTable(g); navigate('table-detail');}} style={s.card}><View style={s.between}><Text style={s.tableTitle}>테이블 {i + 1}</Text><Score value={g.score}/></View><View style={[s.row, {marginTop: 16}]}>{g.memberIds.map(id => {const p = groupPeople.find(p => p.id === id); return p ? <Avatar key={id} profile={toDemoProfile(p)} size={33}/> : null;})}</View><Text style={[s.description, {marginTop: 10}]}>{names(groupPeople.filter(p => g.memberIds.includes(p.id)))}</Text><View style={[s.tags, {marginTop: 16}]}>{g.interests.map(t => <Tag key={t.id}>#{t.label}</Tag>)}</View><Text style={[s.link, {marginTop: 12}]}>테이블 상세 보기</Text></Pressable>)}</Section>{!savedPlan && !canConfirm && <Text style={s.description}>모임을 만든 사람이 편성을 확정할 수 있어요.</Text>}</>;
      case 'table-detail': return table && <><Heading eyebrow="TABLE DETAILS" title={`테이블 ${activePlan?.groups.findIndex(g => g.id === table.id)! + 1}`} description={names(groupPeople.filter(p => table.memberIds.includes(p.id)))}/><View style={s.avatarStack}>{groupPeople.filter(p => table.memberIds.includes(p.id)).map(p => <View key={p.id} style={s.stackPerson}><Avatar profile={toDemoProfile(p)} size={48}/><Text style={s.stackName}>{p.name}</Text></View>)}</View><Card quiet><View style={s.between}><Text style={s.label}>그룹 점수</Text><Score value={table.score} large/></View><QualityRow label="주제 강도" score={table.quality.topicStrength}/><QualityRow label="구성원 균형" score={table.quality.memberBalance}/><QualityRow label="주제 다양성" score={table.quality.topicBreadth}/><QualityRow label="쌍 연결도" score={table.quality.pairCoverage}/></Card><Section title="함께 이야기할 주제 Top 3">{table.interests.length ? table.interests.map(t => <Card key={t.id}><View style={s.between}><Text style={s.sectionTitle}>{t.label}</Text><Score value={t.score}/></View><Text style={s.small}>{t.members.length}/{table.memberIds.length}명 연결 · {topicTypeLabel(t)}</Text><Text style={[s.description, {marginVertical: 14}]}>{t.reason}</Text>{evidenceCards(t, groupPeople)}</Card>) : <Text style={s.description}>근거가 있는 공통 주제가 없어요. 편성은 배정 조건을 충족하지만 관심사 연결 점수는 낮을 수 있어요.</Text>}</Section></>;
      case 'my': return <><Heading eyebrow="UNDERSTAND YOUR INTERESTS" title="나를 알아가는 사이" description="나의 관심사를 담고, 공유할 이야기와 원문 근거를 직접 정해요."/><View style={s.profile}><Avatar profile={toDemoProfile(data.me)} size={68}/><View style={s.flex}><Text style={s.profileName}>{data.me.name}</Text><Text style={s.description}>{data.me.bio || `@${data.account.username}`}</Text><Text style={s.small}>{data.me.interests.filter(t => t.shared).length}개 공유 · {data.me.interests.filter(t => !t.shared).length}개 비공개</Text></View><Pressable accessibilityRole="button" accessibilityLabel="프로필 수정" onPress={() => editProfile()} style={s.profileEdit}><Icon name="pencil-outline"/></Pressable></View><Button secondary onPress={() => startShare('profile')}>프로필 링크 / QR 공유</Button><Section title="관심사 데이터 연결"><Pressable accessibilityRole="button" onPress={() => navigate('youtube')} style={s.integrationCard}><View style={s.integrationIcon}><Icon name="logo-youtube" size={25}/></View><View style={s.flex}><Text style={s.label}>YouTube</Text><Text style={s.small}>재생목록 · 영상 · 구독 채널</Text></View><Tag>{sourceStatus(data.sources?.youtube)}</Tag><Icon name="chevron-forward" size={17}/></Pressable><Pressable accessibilityRole="button" onPress={() => navigate('linkedin')} style={s.integrationCard}><View style={s.integrationIcon}><Icon name="logo-linkedin" size={23}/></View><View style={s.flex}><Text style={s.label}>LinkedIn</Text><Text style={s.small}>개인 프로필 링크에서 관심사 찾기</Text></View><Tag>{sourceStatus(data.sources?.linkedin)}</Tag><Icon name="chevron-forward" size={17}/></Pressable></Section><Section title="나의 관심사" action="전체 보기" onAction={() => navigate('my-interests')}>{data.me.interests.length ? <Card>{data.me.interests.slice(0, 5).map(t => <View key={t.id} style={s.topicRow}><View style={s.flex}><Text style={s.topicTitle}>{t.label}</Text><Text style={s.small}>{t.category} · {preferenceNames[preferenceOf(t)]}</Text></View><Tag>{t.shared ? '공유' : '비공개'}</Tag></View>)}</Card> : <Empty title="어떤 이야기를 좋아하세요?" text="프로필 수정에서 관심사를 직접 등록하거나 외부 데이터를 가져와보세요."/>}<Button disabled={!data.me.interests.some(t => preferenceOf(t) !== 'avoid') || busy} onPress={analyzePersonal}>내 관심사 AI 분석</Button><Text style={s.small}>나의 비공개 관심사도 분석할 수 있어요. 분석이 공개 설정을 바꾸지는 않아요. 웹 첫 분석은 약 614MB 모델을 내려받아요.</Text></Section>{data.me.instagramHandle && <Button secondary onPress={() => Linking.openURL(`https://www.instagram.com/${data.me!.instagramHandle}/`)}>Instagram 프로필 열기</Button>}{data.me.linkedinHandle && <Button secondary onPress={() => Linking.openURL(`https://www.linkedin.com/in/${data.me!.linkedinHandle}/`)}>LinkedIn 프로필 열기</Button>}<Section title="계정"><Button secondary disabled={busy} onPress={logout}>로그아웃</Button>{localDemoEnabled && <Button secondary disabled={busy} onPress={onExample}>예시 데이터로 체험하기</Button>}<Pressable accessibilityRole="button" onPress={() => setDeleteConfirm(!deleteConfirm)}><Text style={s.small}>프로필 삭제</Text></Pressable>{deleteConfirm && <Card><Text style={s.description}>프로필과 친구 연결, 모임 참여 기록을 삭제해요. 계정은 남아 있으며 새 프로필을 만들 수 있어요.</Text><Button secondary disabled={busy} onPress={() => run(async () => {await serviceAction(token, 'deleteProfile'); roomRef.current = undefined; setRoomId(undefined); await load(); setDraft(blankProfile); setFriendIds([]); navigate('profile-edit'); setNotice('프로필을 삭제했어요.');})}>프로필 삭제 확인</Button></Card>}</Section></>;
      case 'share': return share && <><Heading eyebrow="SHARE A CONNECTION" title={share.title} description="링크 또는 QR을 공유해주세요. 받은 사람은 로그인 후 친구 요청이나 모임 참여를 할 수 있어요."/><Card><View style={{alignItems: 'center', padding: 20}}><QRCode value={share.url} size={210}/></View><Text selectable style={s.small}>{share.url}</Text></Card><Button onPress={() => run(async () => {await Clipboard.setStringAsync(share.url); setNotice('링크를 복사했어요.');})}>링크 복사</Button><Button secondary onPress={() => run(async () => {await Clipboard.setStringAsync(share.code); setNotice('코드를 복사했어요.');})}>코드 복사</Button><Button secondary onPress={() => run(async () => {if (Platform.OS === 'web' && navigator.share) await navigator.share({title: share.title, url: share.url}); else if (Platform.OS !== 'web') await Share.share({message: share.url}); else {await Clipboard.setStringAsync(share.url); setNotice('공유할 링크를 복사했어요.');}})}>공유하기</Button></>;
      case 'youtube': return <>
        <Heading eyebrow="REAL DATA · YOUTUBE" title={'즐겨 보는 채널에서\n관심사를 찾을 수 있어요'} description="YouTube를 연결하고 나의 취향을 잘 보여주는 구독 채널을 1~5개 골라주세요."/>
        <Card>
          <View style={s.between}><Text style={s.sectionTitle}>YouTube</Text><Tag>{sourceStatus(data.sources?.youtube)}</Tag></View>
          <Text style={[s.description, {marginVertical: 18}]}>연결하면 채널 목록만 불러와요. 선택한 채널의 이름과 설명에서 비공개 키워드를 만들고, 구체적인 주제를 찾지 못하면 선택한 채널 이름을 사용해요.</Text>
          <Button disabled={busy} onPress={() => run(async () => {const result = await serviceAction<{authUrl: string}>(token, 'startYouTubeOAuth'); if (Platform.OS === 'web') {window.open(result.authUrl, '_blank', 'noopener,noreferrer'); setNotice('연결 창에서 인증을 완료한 뒤 데이터를 새로고침해주세요.');} else await Linking.openURL(result.authUrl);})}>YouTube 연결</Button>
          <Text style={[s.small, {marginTop: 12}]}>Google 계정의 읽기 전용 권한을 사용해요. 연결을 마치면 돌아와 데이터를 새로고침해주세요.</Text>
        </Card>
        <Button secondary disabled={busy} onPress={() => run(async () => {await load(); setNotice('최신 연결 데이터를 확인했어요.');})}>연결 데이터 새로고침</Button>
        <Section title="관심사를 찾을 채널 선택">
          <Text accessibilityLiveRegion="polite" style={s.label}>{youtubeChannelIds.length}/5개 선택</Text>
          {(data.sources?.youtube.channels || []).length ? <Card>{data.sources!.youtube.channels!.map(channel => <Choice
            key={channel.id}
            checked={youtubeChannelIds.includes(channel.id)}
            label={channel.title}
            detail={channel.description}
            detailLines={3}
            disabled={busy || youtubeAnalyzing || (youtubeChannelIds.length >= 5 && !youtubeChannelIds.includes(channel.id))}
            onPress={() => setYoutubeChannelIds(selected => selected.includes(channel.id) ? selected.filter(id => id !== channel.id) : selected.length < 5 ? [...selected, channel.id] : selected)}
          />)}</Card> : <Empty icon="logo-youtube" title="선택할 구독 채널이 없어요" text="YouTube를 연결해 채널 목록을 불러와주세요. 이전에 연결했다면 다시 연결해주세요."/>}
          <Text style={s.small}>선택한 채널의 이름과 설명을 분석해 기존 관심사와 먼저 비교하고, 최소 1개의 키워드를 프로필에 연결해요. 결과는 비공개로 저장되며 공유 여부는 직접 정할 수 있어요.</Text>
          <Button disabled={busy || youtubeAnalyzing || youtubeChannelIds.length < 1 || youtubeChannelIds.length > 5} onPress={extractYouTubeInterests}>{youtubeAnalyzing ? '키워드를 만들고 있어요…' : '선택한 채널에서 키워드 만들기'}</Button>
          {youtubeFeedback?.kind === 'progress' && <View accessibilityLiveRegion="polite" style={s.row}><ActivityIndicator color="#18181B"/><Text style={s.small}>{youtubeFeedback.message}</Text></View>}
          {youtubeFeedback?.kind === 'error' && <View accessibilityRole="alert" style={s.error}><Icon name="alert-circle-outline" color="#A33B34" size={20}/><Text style={s.errorText}>{youtubeFeedback.message}</Text></View>}
          {youtubeFeedback?.kind === 'success' && <Card quiet><Text accessibilityLiveRegion="polite" style={s.label}>{youtubeFeedback.message}</Text><View style={[s.tags, {marginTop: 12}]}>{youtubeFeedback.labels.map(label => <View key={label} style={[s.tag, {maxWidth: '100%'}]}><Text style={s.tagText}>#{label}</Text></View>)}</View><Button secondary onPress={() => editProfile()}>프로필에서 키워드 확인</Button></Card>}
        </Section>
        <Section title="불러온 데이터">{sourceSummary(data.sources?.youtube)}</Section>
        <Button secondary onPress={() => editProfile()}>등록한 관심사와 공유 설정</Button>
      </>;
      case 'linkedin': return <><Heading eyebrow="REAL DATA · LINKEDIN" title={'프로필 링크에서\n관심사를 찾을 수 있어요'} description="내 LinkedIn 개인 프로필을 확인해 관심사 후보 1~5개를 만들어요."/><Card quiet><Text style={s.description}>외부 서비스에서 공개 프로필을 가져오고 AI로 관심사 후보를 만들어요. 후보와 원문 근거를 직접 확인한 뒤 선택한 항목만 비공개로 저장해요.</Text></Card><Section title="LinkedIn 프로필"><TextInput accessibilityLabel="LinkedIn 개인 프로필 링크" editable={!linkedinBusy && !busy} style={s.input} value={linkedinUrl} onChangeText={setLinkedinUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://www.linkedin.com/in/username"/><Button disabled={linkedinBusy || busy || !linkedinUrl.trim() || linkedinJob?.status === 'pending'} onPress={startLinkedInImport}>{linkedinBusy ? '관심사를 찾는 중' : '프로필에서 관심사 찾기'}</Button>{!!linkedinProgress && <Text accessibilityLiveRegion="polite" style={s.small}>{linkedinProgress}</Text>}{linkedinJob?.status === 'pending' && !linkedinBusy && <Button secondary disabled={busy} onPress={() => pollLinkedInJob(linkedinJob)}>진행 상태 다시 확인</Button>}{linkedinBusy && <Button secondary onPress={() => {linkedinOperation.current?.abort(); setLinkedinProgress('진행 확인을 멈췄어요. 나중에 다시 확인할 수 있어요.');}}>진행 확인 멈추기</Button>}</Section>{linkedinCandidates.length > 0 && <Section title={`관심사 후보 · ${linkedinCandidates.length}개`}><Text style={s.description}>새 관심사는 ‘해보고 싶어요’로 분류되고 비공개로 저장돼요. 원하지 않는 후보는 선택을 해제해주세요.</Text>{linkedinCandidates.map(item => {const checked = linkedinSelected.includes(item.id); return <Card key={item.id}><Choice checked={checked} label={item.label} detail={`${item.category} · ${preferenceNames.explore}`} onPress={() => setLinkedinSelected(checked ? linkedinSelected.filter(id => id !== item.id) : [...linkedinSelected, item.id])}/><View style={{marginTop: 12}}><Text style={s.small}>프로필 원문 근거</Text><Text style={[s.description, {marginTop: 5}]}>{item.source?.detail || item.source?.label || 'LinkedIn 공개 프로필에서 확인한 내용'}</Text></View></Card>;})}<Button disabled={busy || linkedinBusy || !linkedinSelected.length} onPress={saveLinkedInCandidates}>선택한 관심사 비공개 저장</Button></Section>}<View style={{alignItems: 'center', marginVertical: 8}}><Text style={s.small}>또는</Text></View><Button secondary disabled={busy || linkedinBusy} onPress={() => setLinkedinManualOpen(!linkedinManualOpen)}>{linkedinManualOpen ? '직접 입력 닫기' : '프로필 텍스트 직접 입력'}</Button>{linkedinManualOpen && <Section title="프로필 텍스트 직접 입력"><Text style={s.description}>Skills, Experience, Education, Projects 또는 한국어 제목을 포함한 텍스트를 붙여넣어주세요.</Text><TextInput accessibilityLabel="LinkedIn 가져오기 텍스트" editable={!busy} style={[s.input, s.textarea]} multiline value={linkedinText} onChangeText={setLinkedinText} maxLength={50000} placeholder={'Skills:\nReact\nSQL\nProjects:\n데이터 시각화'}/><Button disabled={busy || !linkedinText.trim()} onPress={() => run(async () => {const result = await serviceAction<{summary: string}>(token, 'importLinkedInText', {text: linkedinText}); await load(); setNotice(result.summary);})}>직접 입력한 관심사 가져오기</Button></Section>}<Section title="등록한 데이터">{sourceSummary(data.sources?.linkedin)}</Section><Button secondary onPress={() => editProfile()}>가져온 관심사와 공유 설정</Button></>;
      case 'my-interests': return <><Heading eyebrow="YOUR INTEREST PROFILE" title="나의 관심사" description={personal.length ? 'AI가 나의 실제 관심사를 묶고 점수와 근거를 정리했어요.' : '직접 등록하거나 가져온 관심사예요. 공유 설정은 프로필 수정에서 바꿀 수 있어요.'}/>{personal.length ? <Card>{personal.map((t, i) => <TopicRow key={t.id} topic={t} index={i} onPress={() => {setOwnTopic(t); navigate('my-interest-detail');}}/>)}</Card> : data.me.interests.length ? data.me.interests.map(t => <Card key={t.id}><View style={s.between}><Text style={s.label}>{t.label}</Text><Tag>{t.shared ? '공유' : '비공개'}</Tag></View><Text style={[s.small, {marginBottom: 12}]}>{t.category} · {preferenceNames[preferenceOf(t)]}</Text><SourceList sources={[toEvidence(t)]}/></Card>) : <Empty title="등록한 관심사가 없어요" text="프로필 수정이나 데이터 연결로 관심사를 추가해주세요."/>}<Button disabled={busy || !data.me.interests.some(t => preferenceOf(t) !== 'avoid')} onPress={analyzePersonal}>내 관심사 AI 분석</Button><Button secondary onPress={() => editProfile()}>관심사와 공유 설정 수정</Button></>;
      case 'my-interest-detail': return ownTopic && <><Heading eyebrow="YOUR INTEREST EVIDENCE" title={ownTopic.label} description="AI가 이 관심사를 발견한 원문 근거예요."/><Card quiet><View style={s.between}><Text style={s.label}>관심사 점수</Text><Score value={ownTopic.score} large/></View><Text style={[s.description, {marginTop: 14}]}>{ownTopic.category} 분야</Text></Card><Section title="관심사의 근거"><Card><SourceList sources={ownTopic.evidence.map(t => toEvidence(t))}/></Card></Section><Text style={s.small}>분석 결과는 나만 확인해요. 관심사 공개 여부는 프로필의 공유 설정을 따릅니다.</Text></>;
    }
  }

  const home = ['friends', 'groups', 'my'].includes(page);
  const hasProfile = !!data.me;
  return <SafeAreaView style={s.safe} edges={['top', 'bottom']}><StatusBar style="dark"/><View style={s.shell}><View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel="사이 친구 화면으로" disabled={busy || !hasProfile} onPress={() => switchTab('친구')} style={s.brand}><Image accessibilityLabel="사이 로고" source={require('../SAI image.png')} resizeMode="contain" style={s.brandLogo}/></Pressable>{data.account && <Pressable accessibilityRole="button" disabled={busy} onPress={() => hasProfile ? (setRoomName(''), navigate('room-create', '그룹')) : logout()} style={s.headerAction}><Icon name={hasProfile ? 'add' : 'log-out-outline'} size={18}/><Text style={s.headerActionText}>{hasProfile ? '그룹 만들기' : '로그아웃'}</Text></Pressable>}</View>{!home && hasProfile && <View style={s.backRow}><Pressable accessibilityRole="button" disabled={busy} onPress={back} style={s.backButton}><Icon name="arrow-back" size={18}/><Text style={s.link}>뒤로</Text></Pressable><Text style={s.small}>{tab}</Text></View>}<ScrollView ref={scroll} style={s.scroll} contentContainerStyle={[s.content, page === 'analysis' && {flexGrow: 1}]} keyboardShouldPersistTaps="handled">{!!error && <View accessibilityRole="alert" style={s.error}><Icon name="alert-circle-outline" color="#A33B34" size={20}/><Text style={s.errorText}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="오류 메시지 닫기" onPress={() => setError('')}><Icon name="close" size={17} color="#A33B34"/></Pressable></View>}{!!notice && <View accessibilityLiveRegion="polite" style={s.notice}><Icon name="checkmark-circle-outline" size={19}/><Text style={s.noticeText}>{notice}</Text></View>}{busy && <View accessibilityLiveRegion="polite" style={s.row}><ActivityIndicator size="small" color="#18181B"/><Text style={s.small}>요청을 처리하고 있어요…</Text></View>}{renderPage()}</ScrollView>{page === 'friends' && hasProfile && data.friends.length > 0 && <View style={s.selectionBar}><Text style={s.label}>{chosenFriends.length}명 선택됨</Text><Text style={s.small}>{names(chosenFriends)}</Text><Button disabled={busy || chosenFriends.length < 2} onPress={() => analyzeCommon()}>함께 이야기할 주제 보기</Button></View>}{page === 'participants' && hasProfile && <View style={s.selectionBar}><Text style={s.label}>{participantIds.length}명 선택됨</Text><Button disabled={busy || participantIds.length < 3} onPress={() => navigate('conditions')}>다음</Button></View>}{page === 'group-result' && activePlan && !savedPlan && <View style={s.selectionBar}><Button disabled={busy || !canConfirm || !!activePlan.unassigned?.length} onPress={confirmPlan}>이 편성으로 결정</Button></View>}{hasProfile && <View style={s.nav}>{(['친구', '그룹', '마이'] as Tab[]).map(item => <Pressable key={item} accessibilityRole="tab" accessibilityLabel={item} accessibilityState={{selected: item === tab}} disabled={busy} onPress={() => switchTab(item)} style={s.navItem}><Icon name={item === '친구' ? tab === item ? 'people' : 'people-outline' : item === '그룹' ? tab === item ? 'grid' : 'grid-outline' : tab === item ? 'person' : 'person-outline'} size={22} color={item === tab ? '#18181B' : '#9B9BA3'}/><Text style={[s.navText, item === tab && {color: '#18181B', fontWeight: '700'}]}>{item}</Text></Pressable>)}</View>}</View></SafeAreaView>;
}
