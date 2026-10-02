# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-10-03
- Primary product surfaces: Expo web, iOS/Android UI; account service and separate local example experience.
- Evidence reviewed: `mobile/DemoApp.tsx`, `mobile/demo-api.ts`, `shared/demo-types.ts`, `README.md`; current sibling `../SAI/mobile/App.tsx`, `../SAI/mobile/GroupPlanner.tsx`, service API and matching/grouping modules.
- User direction: keep SAI--Demo2 UI/UX and bring in SAI functionality. Use the supplied `SAI image.png` as the header logo in the account and example experiences.

## Brand
- Personality: calm, approachable Korean social-interest app.
- Trust signals: source evidence, explicit sharing controls, real solver status, clearly labeled examples.
- Avoid: invented interest evidence, probability claims, presenting example participants as real accounts.

## Product goals
- Goals: accounts, editable private interests, sources, accepted friends, invite rooms and real CP-SAT assignments in Demo2 screens. Accepted-friend detail includes shared social links and connection removal.
- Non-goals: chat, automatic collection of LinkedIn career data, new dependencies, production deployment.
- Success signals: signup → profile → shared interests → accepted friendship / joined room → comparison → assignment → confirmation survives reload.

## Personas and jobs
- Primary personas: people meeting friends and organizers preparing small tables.
- User jobs: select topics to share, find common ground, invite participants and compare assignments.
- Key contexts of use: personal device; PC recommended for downloading/running browser AI models.

## Information architecture
- Primary navigation: 친구 / 그룹 / 마이.
- Core routes/screens: login/signup, profile setup/edit, friend requests, common topics and evidence, room list/join/detail, participants, conditions, recommendations, table detail, profile sharing, source import, personal AI analysis.
- Content hierarchy: eyebrow → heading → description → section cards → primary action.
- Examples: existing 24 participants appear by default in account friends with example labels; each account gets its own labeled demo room whose planner selects the 24 examples. Explicit entry from account landing/My also opens the separate local Demo mode with return action.

## Design principles
- Reuse Demo2 components and tokens. Keep its 600px centered shell, bottom navigation, cards and spacing.
- Privacy decisions are visible beside each interest and each social link.
- Show common topics only with evidence for every selected person; label partial table topics with participant coverage.
- Conversation topics distinguish 공통 관심사 from 연결 주제. Automatic discovery is enabled by default and remains an explicit user choice: when fewer than three direct topics have evidence for every selected person, Gemini proposes bridge labels from representative public interests and Qwen3 requires per-member relevance of 0.60 plus harmonic consensus of 0.65. The combined result remains Top 3. Turning discovery off keeps direct topics only.
- YouTube connection loads source data without registering interests. Users select one to five subscription channels, then request keyword creation and normalization. The server compares source text with the account's existing private topic catalog through Qwen3; only unmatched evidence goes to Gemini for a candidate label, and Qwen3 verifies generated topic labels against their original source. If AI fails, times out, or produces no usable topics, save one private viewing keyword based on the selected channel name and retain its source; identify this as a source-based fallback rather than an AI-verified topic.
- LinkedIn import accepts only text the user manually exported and pasted. It follows the same existing-topic comparison, unmatched-label generation, and source verification flow as YouTube; LinkedIn account authentication and automatic career collection remain out of scope.
- Source normalization preserves original evidence and never uses another user's data. The topic catalog is private to its account and has no global unbounded generation path. Saving a profile prunes owner topics no longer referenced by trusted saved interests; deleting the profile cascades the remaining catalog. A request accepts at most 40 incoming source items and a profile keeps at most 100 interests. The Qwen match/verification threshold is a provisional 0.75.
- Source privacy filtering excludes contact identifiers and unsupported sensitive evidence before storage. If filtering leaves no verifiable evidence, save nothing and explain the empty result.
- Gemini is required only when source evidence does not match the existing catalog. Qwen source normalization is mandatory; a model error saves no partial result. Existing interests and sharing decisions remain unchanged.
- Bridge detail shows each person's actual interest evidence, connection explanation, and semantic relevance. If no candidate passes validation, explain that a strong conversation topic could not be found; preserve available direct results when discovery is unavailable.
- Tradeoffs: SAI's authenticated APIs remain separate from anonymous Demo APIs; reuse presentation without conflating sessions.

## Visual language
- Color: ink #18181B, muted #71717A, line #E9E9EC, surface #F6F6F7, white cards; existing error treatment.
- Typography: Demo2 system typography; 29/39 heading, 14/23 body, 12/19 supporting copy.
- Spacing/layout rhythm: 24px horizontal content, 13–20px card spacing.
- Shape/radius/elevation: 12–19px rounded controls/cards; quiet panels, minimal borders, no new shadows.
- Motion: scroll to top on page transitions; existing progress spinner; cancellable AI work.
- Imagery/iconography: supplied `SAI image.png` header logo (104 × 40px, contain); Ionicons, circular user avatars, QR for real share links.

## Components
- Existing components to reuse: DemoApp Button, Avatar, Heading, Card, Section, Tag, Empty, Score, TopicRow, QualityRow, SourceList and styles.
- New/changed components: account screens, profile/privacy editor, invitations, request management, real room planner.
- Variants and states: existing primary/secondary/disabled controls; selected checkbox/radio/tab semantics.
- Token/component ownership: `mobile/DemoApp.tsx`; service composition `mobile/SAIApp.tsx`.

## Accessibility
- Target standard: retain labeled inputs and accessible roles; reasonable touch sizes and readable contrast.
- Keyboard/focus behavior: native Pressable/TextInput interaction and ScrollView; preserve entered data on errors.
- Contrast/readability: existing Demo2 colors; secondary content remains readable.
- Screen-reader semantics: meaningful labels, checked/selected states, alerts and live status messages.
- Reduced motion and sensory considerations: no new animations; nonanimated page scrolling.

## Responsive behavior
- Supported breakpoints/devices: full width through 600px; centered shell above 600px.
- Layout adaptations: wrap tags, avoid fixed widths, scroll long profile forms and evidence.
- Touch/hover differences: all actions support touch; no hover-only information.

## Interaction states
- Loading: boot spinner, disabled duplicate mutations, actual model progress.
- Empty: explain next step for no friends/rooms/shared interests.
- Error: preserve inputs and show dismissible server message; allow retry.
- Success: concise saved/imported notice; refresh authenticated state.
- Disabled: only when required fields/selection/permissions or pending request prevent the action.
- Source import: show AI analysis/normalization progress, preserve input or YouTube selection on errors, and explain that only source-verified interests are saved privately. YouTube shows the selected count out of five, disables additional unselected channels at the limit, and enables analysis once at least one channel is selected. Show progress, errors, and at least one saved or reused keyword next to the action. Keep results visible until another analysis or account change, retain selection after failures, and abort stale operations when leaving the page. The client stops waiting after 150 seconds.
- Offline/slow network: expose request failure; cancel browser model work when leaving the page.

## Content voice
- Tone: short, friendly Korean consistent with Demo2.
- Terminology: 관심사, 공유, 친구 요청, 모임, 테이블, 편성.
- Conversation recommendation labels: 공통 관심사 / 연결 주제; use 함께 이야기할 주제 for the combined Top 3. Explain automatic discovery and its opt-out where the choice is shown.
- Microcopy rules: separate explicit likes/avoid/explore; distinguish manual input and YouTube/LinkedIn sources; score is a reference, not relationship probability.

## Implementation constraints
- Framework/styling system: existing React Native / Expo / StyleSheet.
- Design-token constraints: reuse Demo2 exports, no new design framework.
- Performance constraints: existing browser Web Workers; disclose initial model download and PC recommendation.
- Server model constraint: source normalization, optional Direct semantic comparison, and Bridge validation share the Vercel-native Qwen runtime cached per function instance; no separate semantic execution server is required.
- Compatibility constraints: bearer service sessions use existing `sai-session` storage; Demo cookie remains independent/local-only.
- Test/screenshot expectations: TypeScript, export build, service and Demo smokes, isolated browser flow and mobile/desktop screenshots where available.

## Open questions
- [ ] Real Google OAuth credentials/account validation require user-owned setup; preserve clear setup errors.
- [ ] Physical iOS/Android validation and public deployment are outside this local integration.
