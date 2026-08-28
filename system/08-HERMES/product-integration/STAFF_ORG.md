# Wave 4: A 50-Person Company on Your Desktop

**Product:** AE Staff  
**Subtitle:** Powered by Hermes  
**Governor and product context:** Orange

AE Staff is a flat company of exactly 50 logical action roles. Orange governs
intent, policy, routing, approvals, evidence, receipts, and completion. Hermes
provides the hardened execution-profile substrate. Studios identify disciplines;
they are not departments, reporting layers, or management positions.

## Architecture Contract

All 50 roles are live Bun actors. They are stable logical identities with their
own entry conditions, concrete outputs, completion contracts, forbidden actions,
handoffs, and routing intent. Fifty actors do not mean fifty model processes,
fifty gateways, or fifty resident workers.

The 50 actors map onto exactly seven hardened Hermes execution profiles:

1. `navigator`
2. `builder`
3. `researcher`
4. `reviewer`
5. `visual`
6. `misfit`
7. `human-operator`

The `archetype` on each roster entry names its eligible Hermes profile. Only a
role selected for a bounded task may lease that profile. An unselected role
remains a live Bun actor without consuming a Hermes profile, model lease, or
heavy memory residency. A role's `modelTier` is routing intent only; Orange still
selects the smallest sufficient live route and may return a truthful blocker.

## Flat Ownership

`orange-hermes-navigator` is the only Navigator and directly owns all other 49
roles. Every specialist has `reportsTo: orange-hermes-navigator`. There are no
middle managers, studio heads, or permanent sub-organizations.

`canLead` is temporary crew eligibility, not rank. A `canLead` specialist:

- remains responsible for concrete specialist output;
- may form only a scoped, time-bounded project crew authorized by the Navigator;
- may delegate only separable work with explicit entry and completion contracts;
- must obey Swarmgate, collision, lease, approval, and shared-write boundaries;
- returns synthesis and custody to the Navigator when the bounded crew ends.

The current roster grants specialist crew eligibility only to Researcher actors,
which matches the hardened Hermes depth-two orchestration profile. The roster
does not raise the current runtime limits: six immediate workers, depth two,
eight durable in-progress tasks, and at most two tasks per profile.

## Work Lifecycle

1. Orange authorizes one root work object and records scope, risk, approvals,
   acceptance criteria, and stop conditions.
2. The Navigator selects the smallest sufficient logical role or bounded crew.
3. Each selected Bun actor receives one explicit work contract. Only actors that
   need profile capabilities acquire their mapped Hermes profile lease.
4. Actors produce their declared concrete outputs and return evidence, confidence,
   blockers, and a next action through durable task state.
5. Review, Misfit pressure, and human acceptance remain separate from mutation.
6. Orange receipts, not actor prose, model output, process start, or Kanban state,
   determine completion. Leases close and custody returns to the Navigator.

## Role Contract

Every role in `config/staff-roster.json` declares:

- `id`, `title`, `studio`, and one of the seven `archetype` values;
- a hands-on `purpose` and inspectable `concreteOutputs`;
- `entryConditions` and a falsifiable `completionContract`;
- explicit `forbiddenActions` and ID-checked `preferredHandoffs`;
- `canLead`, `modelTier`, and direct `reportsTo` ownership.

Studios can collaborate freely through explicit handoffs. A studio label never
grants signing, approval, mutation, dispatch, or personnel authority.

## Staff Roster

| # | Role ID | Working title | Studio | Hermes profile | Tier | Crew |
|---:|---|---|---|---|---|:---:|
| 1 | `orange-hermes-navigator` | AE Staff Navigator | Navigation | navigator | navigator | yes |
| 2 | `product-systems-builder` | Product Systems Builder | Product Engineering | builder | code | no |
| 3 | `interface-engineer` | Interface Engineer | Product Engineering | builder | code | no |
| 4 | `integration-engineer` | Integration Engineer | Product Engineering | builder | code | no |
| 5 | `data-contract-engineer` | Data Contract Engineer | Product Engineering | builder | code | no |
| 6 | `automation-engineer` | Automation Engineer | Runtime Engineering | builder | code | no |
| 7 | `test-harness-engineer` | Test Harness Engineer | Runtime Engineering | builder | code | no |
| 8 | `performance-engineer` | Performance Engineer | Runtime Engineering | builder | code | no |
| 9 | `reliability-engineer` | Reliability Engineer | Runtime Engineering | builder | code | no |
| 10 | `security-boundary-engineer` | Security Boundary Engineer | Trust Engineering | builder | code | no |
| 11 | `accessibility-engineer` | Accessibility Engineer | Product Engineering | builder | code | no |
| 12 | `creative-technologist` | Creative Technologist | Creative Technology | builder | code | no |
| 13 | `primary-source-researcher` | Primary Source Researcher | Evidence Research | researcher | navigator | yes |
| 14 | `product-researcher` | Product and Audience Researcher | Evidence Research | researcher | navigator | yes |
| 15 | `technical-standards-researcher` | Technical Standards Researcher | Evidence Research | researcher | navigator | yes |
| 16 | `human-factors-researcher` | Human Factors Researcher | Evidence Research | researcher | navigator | yes |
| 17 | `model-evaluation-researcher` | Model Evaluation Researcher | Evaluation Science | researcher | heavy | yes |
| 18 | `provenance-researcher` | Provenance Researcher | Evidence Research | researcher | navigator | no |
| 19 | `evidence-auditor` | Evidence Auditor | Proof and Safety | reviewer | heavy | no |
| 20 | `behavior-reviewer` | Behavior Reviewer | Proof and Safety | reviewer | navigator | no |
| 21 | `security-reviewer` | Security Reviewer | Proof and Safety | reviewer | heavy | no |
| 22 | `privacy-rights-reviewer` | Privacy and Rights Reviewer | Proof and Safety | reviewer | navigator | no |
| 23 | `performance-reviewer` | Performance Reviewer | Proof and Safety | reviewer | heavy | no |
| 24 | `accessibility-reviewer` | Accessibility Reviewer | Proof and Safety | reviewer | visual | no |
| 25 | `usability-reviewer` | Usability Reviewer | Proof and Safety | reviewer | visual | no |
| 26 | `release-proof-reviewer` | Release Proof Reviewer | Proof and Safety | reviewer | heavy | no |
| 27 | `assumption-breaker` | Assumption Breaker | Constructive Dissent | misfit | heavy | no |
| 28 | `scope-contrarian` | Scope Contrarian | Constructive Dissent | misfit | navigator | no |
| 29 | `false-green-hunter` | False-Green Hunter | Constructive Dissent | misfit | heavy | no |
| 30 | `product-experience-designer` | Product Experience Designer | Experience Design | visual | visual | no |
| 31 | `interaction-designer` | Interaction Designer | Experience Design | visual | visual | no |
| 32 | `visual-systems-designer` | Visual Systems Designer | Experience Design | visual | visual | no |
| 33 | `typography-designer` | Typography Designer | Experience Design | visual | visual | no |
| 34 | `brand-identity-designer` | Brand Identity Designer | Brand Studio | visual | visual | no |
| 35 | `information-designer` | Information Designer | Experience Design | visual | visual | no |
| 36 | `content-designer` | Content Designer | Experience Design | visual | navigator | no |
| 37 | `illustration-artist` | Illustration Artist | Brand Studio | visual | creative | no |
| 38 | `motion-designer` | Motion Designer | Motion Studio | visual | creative | no |
| 39 | `storyboard-artist` | Storyboard Artist | Motion Studio | visual | visual | no |
| 40 | `cinematography-specialist` | Cinematography Specialist | Motion Studio | visual | visual | no |
| 41 | `three-d-scene-artist` | 3D Scene Artist | Spatial Media | visual | creative | no |
| 42 | `generative-image-artist` | Generative Image Artist | Generative Media | visual | creative | no |
| 43 | `video-synthesis-artist` | Video Synthesis Artist | Generative Media | visual | creative | no |
| 44 | `sound-designer` | Sound Designer | Audio Studio | visual | creative | no |
| 45 | `music-composer` | Music Composer | Audio Studio | visual | creative | no |
| 46 | `voice-dialogue-designer` | Voice and Dialogue Designer | Audio Studio | visual | creative | no |
| 47 | `media-quality-reviewer` | Media Quality Reviewer | Creative Quality | visual | visual | no |
| 48 | `human-interface-operator` | Human Interface Operator | Human Operations | human-operator | human-operator | no |
| 49 | `media-capture-operator` | Media Capture Operator | Human Operations | human-operator | human-operator | no |
| 50 | `release-acceptance-operator` | Release Acceptance Operator | Human Operations | human-operator | human-operator | no |

## Coverage

The profile distribution is exactly 1 Navigator, 11 Builders, 6 Researchers,
8 Reviewers, 18 Visual specialists, 3 Misfits, and 3 Human Operators. The three
Misfits have distinct jobs: breaking hidden assumptions, defending literal
scope, and attacking false-green completion claims.

Creative work is a first-class production capability, not a single generic role.
Coverage includes product experience, interaction, visual systems, typography,
brand, information design, content, illustration, motion, storyboards,
cinematography, 3D, generative images, synthetic video, sound, music, voice and
dialogue, media capture, creative technology, and independent media-quality
review. Provenance, privacy, accessibility, and release proof remain separate
working roles so creative speed cannot erase evidence or human authority.

## Completion Boundary

AE Staff may propose, research, build, review, create, pressure-test, and perform
explicitly leased human-computer actions. Orange remains the governor. No role,
crew, studio, model tier, or Hermes profile may approve its own unsupported
claim, bypass LOOM, create a second dispatcher, or convert technical artifact
validity into a production-quality claim without the required review and receipt.
