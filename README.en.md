# Momoki · 默默

**A local-first AI creative studio for developing stories, visuals, audio, and music.**

[简体中文](README.md) · **English**

Momoki brings a creative assistant, film storyboarding, audio production, music generation, and reusable IP and material libraries into one shared browser and desktop workspace. Work directly in the editors, or ask the assistant to use project references, organize a task, and operate creative tools—then inspect the results saved in the workspace.

The desktop product stores project data in an internal SQLite database and copies media into its managed file workspace. The browser uses the same interface, business commands and Agent with IndexedDB. AI features use your own service connections and API keys (BYOK). The browser can be deployed as a static website or with Docker; no application database is required on the server. See [desktop distribution](docs/desktop-distribution.md) for installer targets and the release verification process.

> Video, audio, and music projects are available. Standalone image and copywriting workspaces are marked “coming soon”; image generation and text editing within existing video workflows are available. The application UI is primarily Chinese. This English README does not imply a fully localized English UI.

## Contents

- [Download and install](#download-and-install)
- [Features](#features)
- [First steps](#first-steps)
- [Creative workflows](#creative-workflows)
- [AI connections and models](#ai-connections-and-models)
- [Data, privacy, and backups](#data-privacy-and-backups)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Umami analytics](#umami-analytics)
- [Technology and repository structure](#technology-and-repository-structure)
- [Quality checks and contributing](#quality-checks-and-contributing)
- [FAQ](#faq)
- [Documentation and implementation scope](#documentation-and-implementation-scope)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Download and install

**[Download a desktop preview](https://github.com/ROYIANS/momoki/releases) · [Illustrated installation guide (Chinese)](docs/desktop-installation.md)**

Choose a desktop release with a `desktop-v<version>` tag, expand **Assets**, and select the installer for your device:

| Device | File to choose |
| --- | --- |
| Apple silicon Mac (M series, macOS 14+) | `.dmg` with `macos_arm64` in its name |
| Intel Mac (macOS 14+) | `.dmg` with `macos_x64` in its name |
| x64 Windows | `_setup.exe` with `windows_x64` in its name |
| x64 Linux | `.deb` or `.AppImage`; Ubuntu 22.04 build baseline, with compatible runtime dependencies |

**Your system may show a warning on first installation or launch.** The Windows package is unsigned; the Mac application uses an ad-hoc signature and has not completed Developer ID signing or Apple notarization. Confirm that the file came from the official release above, then use the [Windows / Mac illustrated steps](docs/desktop-installation.md) to decide whether to continue. You do not need to disable system security features.

If a warning reports malware, a virus, or a damaged file, stop installation and [report the full message](https://github.com/ROYIANS/momoki/issues). **Source code (zip / tar.gz)** files are source archives, not installers. Windows ARM, Linux ARM, and universal Mac installers are not currently provided. From 0.1.3, **Settings → About and updates** can check versions, download and verify an installer, and save it for you to install. Export project ZIP backups before updating.

## Features

| Area | Implemented capabilities |
| --- | --- |
| Creative assistant | Streaming conversations, project binding, task plans, tool execution, permissions, installed skills, MCP connections, execution history, and saved outcomes. Work in progress can continue after leaving the conversation |
| Video projects | Films and series, world settings, stories and scenes, shot lists, asset relationships, visual generation, and production delivery |
| Audio projects | Chapters and manuscripts, speakers and voices, speech generation, microphone recording, source auditions, multitrack editing, and WAV mixdown |
| Music projects | Drafts, Suno / Flow Music generation, playback and favorites, settings reuse, downloads, and adoption into audio projects |
| IP profiles | Multiple persistent creative identities, project relationships, and IP-scoped materials |
| Material library | Images, videos, audio, documents, and character / scene / prop / style settings, with versions and project adoption records |
| Project memory | Reviewed conventions, preferences, decisions, and lessons with version history and provenance |
| References | Local extraction of images, TXT / Markdown, text PDFs, and DOCX for assistant search and reading |
| Web research | Web search and page extraction through a separately configured Tavily connection, with visible sources |
| Delivery and migration | Project ZIP import/export, episode CSV, printable storyboards, production handoff archives, and audio downloads |

## First steps

1. Install a desktop preview using [Download and install](#download-and-install). For the browser version, start the image using [Deployment](#deployment), or launch the development server using [Local development](#local-development).
2. Open **设置 → 连接与模型** (Settings → Connections and models), add a service, enter its Base URL and API key, and test the connection or inspect available models.
3. Create a video, audio, or music project from **项目** (Projects). Projects can stand alone or be linked to a profile under **我的 IP** (My IP).
4. Add your manuscript and materials manually, or open **创作助手** (Creative assistant), choose a chat connection and model, and bind the target project.
5. Review permissions and generation settings when using tools, then inspect saved results in the appropriate workspace.
6. Export project ZIP backups regularly, particularly before moving to another browser, device, or deployment origin.

Local project editing, material management, and supported exports do not require an API key. Chat, AI generation, and web research require the relevant configured services.

## Creative workflows

### Video: story → shots → production → delivery

- **Organize the project:** films use one internal episode; series support multiple episodes sharing project settings and assets.
- **Define the world:** maintain characters, scenes, props, visual styles, and world settings; adopt copies of studio assets into the project.
- **Develop the story:** edit scripts and story scenes, then turn them into specific shots.
- **Edit shots:** manage order, duration, status, prompts, and asset relationships using filters, drag operations, and keyboard actions.
- **Produce visuals:** review the provider, model, prompt, and destination in the assistant's generation flow; inspect candidates and adopt them into shots or assets.
- **Prepare delivery:** inspect missing information and media, then export an episode CSV, printable storyboard, or production material handoff ZIP.

A production handoff archive delivers shots and materials. A project backup ZIP is intended for reimport into Momoki. Momoki does not currently provide a complete video editing timeline, transition compositor, or automatic full-film renderer.

### Audio: manuscript → voices → tracks → output

- Write chapters and script segments, assign speakers, and split pasted multiline manuscripts into segments.
- Configure MiMo preset voices, natural-language voice design, or reference-based voice cloning. Audition and save reusable speaker configurations.
- Generate narration, import audio, or record with a microphone. Recording requires an explicit user action and browser permission.
- Keep multiple takes, audition them, select the take to use, and place it on the timeline.
- Arrange multiple tracks; move, trim, split, and duplicate clips; adjust gain and fades; inspect the mix using mute and solo.
- Export a chapter or the complete project as WAV. Export history distinguishes older outputs from the current edit state.

New speech defaults to MiMo configuration; existing APIMart speech configurations remain supported. Music works can be explicitly adopted into an audio project as new takes for further editing.

### Music: draft → generated versions → library

- Write descriptions, lyrics, and style settings in drafts. Choose simple, custom, or Flow creation options according to the engine.
- Submit Suno / Flow Music jobs through APIMart and retain provider task identifiers and results.
- Search, audition, favorite, and download works; reuse a work's settings to start another draft.
- Save works to the material library or adopt them into audio projects.

Models, parameters, account permissions, quotas, and charges depend on the provider. Provider completion, successful local download, and human audition are separate steps.

### Assistant: execute in context and inspect outcomes

The assistant can use its bound project, references, and project memory to plan work, read project data, edit creative records, and call enabled generation or research tools. Ordinary conversation and tool execution modes have different capabilities; enabled tools and permissions determine which actions are available.

| Permission mode | Behavior |
| --- | --- |
| 请求批准 — Ask for approval | Asks before editing business data or using internet tools |
| 帮我批准 — Assisted approval | Executes routine operations automatically; asks for high-risk actions and paid generation |
| 完全访问 — Full access | Executes enabled tools autonomously; paid generation still requires configuration review |

Execution history exposes tool calls, pending actions, stop reasons, and actual saved changes. Generation jobs and candidates remain available for inspection, adoption, and further processing. An assistant message saying “done” does not replace checking the workspace's saved results.

Maintain project memory manually or derive reusable knowledge from confirmed task summaries. Documents are parsed locally; selected text or images are sent to the chosen provider when used in an AI request. Scanned PDFs have no OCR guarantee, and image understanding requires a capable selected model.

### IP and material reuse

An IP profile organizes a long-lived creative identity or world; it is not a separate project type. Materials may belong to the studio globally, an IP, or an individual project. Adoption creates project-owned copies and records the adopted version. Publishing a new shared material version does not silently replace settings or visuals already used by projects.

## AI connections and models

Connections are studio-wide, so projects can reuse them. Choose the chat model in the assistant and confirm generation models and parameters in their respective flows.

| Connection | Use in Momoki |
| --- | --- |
| OpenAI-compatible | Compatible chat services, proxies, or local gateways |
| DeepSeek | A preset connection for its compatible chat service |
| APIMart | Chat, image/video generation, and audio/music adapters |
| AIHubMix | Chat and image/video generation |
| MiMo | Chat, speech synthesis, voice design, and voice cloning |
| Tavily, configured separately | Assistant web search and page extraction |

Model lists and capability hints combine provider metadata with the bundled or user-synced Models.dev model catalog. They do not establish account permissions. Public model discovery, authenticated connection tests, and actual generation are distinct operations.

The generic OpenAI-compatible connection test first requests the model list. If the endpoint is unsupported or certain network errors occur, it may fall back to a minimal chat request, which can incur a small amount of provider usage. Dedicated connectors use their own test protocols.

The browser calls providers directly, so those services must allow the necessary cross-origin requests (CORS). The desktop product uses the official native HTTP transport while retaining the same configured-origin policy, cancellation and provider protocols. Configure your own compatible gateway if a proxy is needed; this repository does not include an application backend proxy. Use HTTPS provider endpoints when the application is served over HTTPS.

## Data, privacy, and backups

### Where data lives

| Data or operation | Storage or destination |
| --- | --- |
| Projects, manuscripts, shots, materials, audio, conversations, tasks, and memory | Desktop: internal SQLite and managed files. Browser: the current origin's IndexedDB; some UI preferences use local storage |
| AI and search credentials | Stored locally in the current application profile; used to authenticate requests to the corresponding service |
| AI conversations, generation descriptions, and selected reference text/images/audio | Sent to configured services when the relevant features are used |
| Web research queries and extraction URLs | Sent to Tavily when research tools run |
| Website resources | Loaded from the deployment; the page also requests Google Fonts |
| Optional analytics | Standard pageview data is sent when Umami is configured in a production build |

“Local-first” describes project storage. It does not mean every feature works offline, and browser storage is not an operating-system keychain. There is no built-in account service, automatic cross-device sync, or real-time collaborative backend.

Desktop profiles and browser origins have separate data identities; automatic synchronization between them is not implemented. Imports copy files into the application workspace, so subsequent deletion of the original source does not remove the imported media.

Browser profiles and origins isolate data. Changing the domain, scheme, or port, switching browsers, using private browsing, or clearing site data can make existing projects inaccessible or remove them. Server containers and volumes do not back up visitors' browser databases.

### Project ZIP coverage

Export from a project's menu and restore using **导入项目** (Import project) in the studio sidebar. The package identifier remains `aifenjing-project-v1` for compatibility with existing backups.

| Included | Not included |
| --- | --- |
| Project settings, video episodes and shots, project-owned characters/scenes/props/styles | AI connections, API keys, and Tavily credentials |
| Referenced and retained project media, references, and extracted text chunks | Complete Agent conversations, execution ledgers, and task history |
| Project memory and its version history | All studio IP profiles and the complete shared material library |
| Audio/music project records and related media | Studio material snapshots that have not been adopted into the project |

Import creates independent project and resource IDs. Imported memories require review, and historical generation jobs do not automatically resubmit paid requests. A project ZIP is a project backup and migration format, not a complete image of the browser's studio.

## Local development

### Prerequisites

Browser and the main GHCR quality job use **Node.js 22**; the independent Agent example and desktop release jobs use **Node.js 24.11.0**, as described in the [desktop distribution guide](docs/desktop-distribution.md). Follow the `packageManager` entry in [`package.json`](package.json), currently **pnpm 10.15.0**. In an existing workspace, also follow [`AGENTS.md`](AGENTS.md) and machine-specific package-manager instructions to avoid rebuilding dependencies with an incompatible version.

```bash
git clone https://github.com/ROYIANS/momoki.git
cd Momoki
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open the URL printed by Vite, usually `http://localhost:5173`. Basic startup requires no `.env` file, database, Redis, or server-side AI credentials.

### Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the web application development server |
| `pnpm dev:site` | Start the independent landing site |
| `pnpm --filter @momoki/desktop build:frontend` | Build the normal desktop frontend |
| `pnpm agent:build` | Emit the reusable Agent libraries and their declarations |
| `pnpm agent:example:check` | Offline packed-consumer and durable SQLite conformance outside the workspace (Node ≥24.11) |
| `pnpm quality` / `pnpm quality:self-test` | Check all owned sources and verify gate failure cases |
| `pnpm build` | Build web/site separately and assemble their checked output in `dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm lint` | Run `tsc -b` for TypeScript checking |
| `pnpm test` | Run the complete Vitest suite |
| `pnpm exec vitest run tests/umami.test.ts` | Run one test file |
| `pnpm models-dev:baseline` | Regenerate the bundled model catalog baseline from the pinned `@opencode-ai/models` |
| `pnpm models-dev:verify` | Verify the bundled baseline matches the pinned package version |

## Deployment

### Docker Compose

Image: `ghcr.io/royians/momoki`. See the [GHCR package](https://github.com/ROYIANS/momoki/pkgs/container/momoki). Obtain [`docker-compose.yml`](docker-compose.yml) from this repository and run these commands from its directory:

```bash
# Login is only needed if the image package is private.
printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

docker compose pull
docker compose up -d
```

Open `http://localhost:8080`. Compose maps host port `8080` to Nginx port `80` and uses the `unless-stopped` restart policy. For public HTTPS access, place a TLS reverse proxy in front of the site. Recording requires HTTPS or a local secure context.

The image has a built-in health check: every 30 seconds the container requests `/healthz`, which answers 200 only while the site files are present, so `docker compose ps` shows `healthy` or `unhealthy`. Update with `docker compose pull` and `docker compose up -d`. To pin a release, replace `latest` in Compose with an available version tag.

### Build the image locally

```bash
docker build -t ghcr.io/royians/momoki:latest .
docker compose up -d
```

The Dockerfile installs locked dependencies and builds the frontend in a Node stage, then copies `dist/` into Nginx. The runtime needs neither Node nor an application database. Project data is not stored in the container.

### Static hosting

Run `pnpm build` and deploy `dist/`. Configure an SPA fallback to `index.html` when a requested file does not exist; otherwise, opening or refreshing a project detail URL will return 404. Current routes and assets assume deployment at the site root. Hosting under a subdirectory requires additional configuration and verification.

[`deploy/nginx.conf`](deploy/nginx.conf) includes route fallback, gzip, asset caching, and HTML revalidation. `pnpm preview` is for local verification; use a production static server or hosting platform for deployment.

### GitHub Actions publication

The [workflow](.github/workflows/ghcr.yml) runs on pushes to `main`, `v*` tags, pull requests targeting `main`, and manual dispatch. Its quality job installs locked dependencies, checks types, runs tests, verifies the model snapshot, and builds production assets. Image publication depends on that job succeeding. Pull requests do not publish images.

The default branch publishes `latest`, version tags produce semver tags, and images also receive a commit SHA tag. The publication job uses `GITHUB_TOKEN` with `packages: write`; repository or organization policy must allow that permission.

When publishing from a fork, update the fixed image name in the workflow and the corresponding Compose and local-build tags.

## Umami analytics

Connect an existing Umami instance. No analytics service or runtime environment configuration needs to be added to Compose.

### GitHub configuration

Open **Repository → Settings → Secrets and variables → Actions → Variables** and add two repository variables:

| Variable | Value |
| --- | --- |
| `VITE_UMAMI_SCRIPT_URL` | The full tracker `src`, such as `https://analytics.example.com/script.js` |
| `VITE_UMAMI_WEBSITE_ID` | The `data-website-id` from the same tracking code |

Both are required. The script must have an absolute HTTP(S) URL; use HTTPS for an HTTPS website. These values are public and embedded in the frontend. Use Variables, and do not enter an administrator password or API token.

After saving, run **Actions → Quality checks and GHCR image → Run workflow** on `main`, or push a new commit. Wait for publication, then pull the image and recreate the container.

These settings take effect at **build time**. Changing GitHub variables or adding environment variables to an existing container does not alter an old image. To disable analytics, clear either value, rebuild/publish, and redeploy.

### Local builds and verification

Copy [`.env.example`](.env.example) to `.env.local`, fill both values, then run `pnpm build` and `pnpm preview`. `pnpm dev` does not load analytics.

Local environment files are excluded from Git and Docker contexts. Pass local Docker build settings explicitly:

```bash
docker build \
  --build-arg VITE_UMAMI_SCRIPT_URL=https://analytics.example.com/script.js \
  --build-arg VITE_UMAMI_WEBSITE_ID=YOUR_WEBSITE_ID \
  -t ghcr.io/royians/momoki:latest .
docker compose up -d
```

The tracker loads asynchronously once and handles SPA navigation. This integration adds no business events and does not explicitly attach project contents, prompts, or provider credentials. Standard pageview metadata still includes the URL, title, and referrer.

After deployment, inspect the browser's Network panel for the script and collection requests, normally `/api/send`, while navigating. Confirm visits under the matching website in Umami. Content blockers may prevent tracking. See the [Umami tracker configuration](https://docs.umami.is/docs/tracker-configuration) and [SPA guide](https://docs.umami.is/docs/guides/track-single-page-apps).

## Technology and repository structure

| Layer | Technologies and responsibilities |
| --- | --- |
| Frontend | React 19, TypeScript, Vite 7 |
| Routing | TanStack Router file routes and automatic code splitting |
| Local data | Shared ProductStore commands and queries; desktop SQLite / managed files; browser Dexie / IndexedDB |
| UI | Tailwind CSS 4, Radix UI, Ant Design, Lobe UI, Lucide, Motion |
| AI | Shared provider adapters and Agent tools/runtime, native or browser HTTP, model catalog (Models.dev) metadata |
| Documents and media | PDF.js, Mammoth, JSZip, Web Audio, MediaRecorder |
| Desktop | Tauri 2 / Rust, SQLite, native HTTP and file/system services |
| Verification and deployment | Vitest, fake-indexeddb, TypeScript, GitHub Actions, Docker / Nginx |

```text
apps/
├── web/                    # Browser HTML, bootstrap and Vite configuration
├── desktop/                # Tauri entry, Rust runtime, native/release tooling
│   └── reference/electron/ # Retained historical prototype
└── site/                   # Independent lightweight landing site
packages/
├── studio/                 # Shared product used by web and desktop
│   └── src/
│       ├── app/            # Bootstrap, routes, frame and cross-feature workflows
│       ├── features/       # projects, video, audio, music, library,
│       │                   # references, memory, settings and agent
│       ├── platform/       # Storage, runtime, HTTP, media and fixed product services
│       └── ui/             # Shared controls, icons and theme
├── distribution/           # Brand, analytics, release/version/platform data
│   └── public/brand/       # Shared product identity assets
├── agent-core/             # Neutral execution, tools and context mechanisms
└── agent-providers/        # Chat Completions/Responses and public HTTP mechanisms
examples/
└── agent-todo/             # Independent SQLite CLI consuming public Agent packages
tooling/                    # Workspace, build, quality, model/native helpers
tests/                      # Cross-package integration and permanent tests
quality/                    # Source ownership, exact debt/retention contracts
deploy/                     # Nginx site-root and app SPA fallback
.github/workflows/          # Root quality/GHCR and desktop packaging lanes
docs/                       # Product and architecture documentation
.trellis/                   # Development specs, tasks and session records
```

Each feature owns its models, commands, queries, UI, tests and product tool bindings as needed. For example, Audio editing lives in `packages/studio/src/features/audio/`. The app layer composes features, `platform/storage` supplies storage mechanisms, and `platform/product/store.ts` selects the fixed product store. Packages use declared public exports; features cooperate through concrete command, query or service entries.

[`@momoki/agent-core`](packages/agent-core/README.md) owns neutral Agent mechanisms. [`@momoki/agent-providers`](packages/agent-providers/README.md) supplies the existing protocols and an explicit public `/http` entry, with emitted ESM and declarations. Studio owns creative tools/prompts, project scope, reference pixels, current credentials, runtime HTTP authorization and product transactions.

[`agent-todo`](examples/agent-todo/README.md) uses its own SQLite tables and business tools to demonstrate approval, rejection, cancellation and explicit recovery after process restart. It calls the same Agent execution implementation and demonstrates the host adapter another project supplies. `agent:example:check` installs local packed artifacts offline outside the workspace before checking the consumer. The example requires Node ≥24.11; shared libraries and web quality checks retain Node 22 support.

## Quality checks and contributing

Read [`AGENTS.md`](AGENTS.md) and the relevant [Trellis development guidelines](.trellis/spec/frontend/index.md) before making changes. Persist product data through concrete commands in `packages/studio/src/features/<feature>/commands/`. Nested operations retain the caller's store and transaction context. Preserve project ownership, revision conflict checks, and import/export contracts.

Validate changes according to their scope. The complete release gate is:

```bash
pnpm lint
pnpm quality
pnpm quality:self-test
pnpm test
pnpm models-dev:verify
pnpm build
pnpm agent:example:check # This check requires Node ≥24.11
```

`lint` currently means type checking, not ESLint. Tests emphasize pure logic, repositories, and runtimes. Recording, browser CORS, actual model quality, and paid generation need separate real-environment verification. Distinguish mocked tests from live-provider validation in change descriptions, and preserve third-party licenses and snapshot provenance.

## FAQ

**Why did my projects disappear after changing the address?**

Browser storage is origin-scoped. `http://localhost:8080` and a production HTTPS domain use different databases. Export project ZIPs from the original address and import them at the new one.

**Does the assistant keep working after I close the page?**

Browser-based multistep execution does not continue as a background service. Asynchronous jobs already submitted to a provider may continue remotely. Reopening can allow querying or recovery using saved task records. Stopping local waiting does not cancel remote generation or charges.

**Why does a connection fail even with an API key?**

Check the Base URL, model access, balance, HTTPS, and CORS. Public model discovery does not establish key validity. There is no built-in proxy; the provider must permit browser requests, or you must configure your own compatible gateway.

**Why can't I create image or copywriting projects?**

Those standalone workspaces are not open yet. Image generation, script editing, and prompt editing in video workflows remain available.

**Why is microphone recording unavailable?**

Check HTTPS or localhost access, MediaRecorder support, microphone permission, and device availability.

**Can a project ZIP restore the entire studio?**

No. It excludes full conversation history, global connections, all IP profiles, and the complete material library. See [Project ZIP coverage](#project-zip-coverage).

**Why did changing Umami variables not enable tracking?**

Rebuild and redeploy the image, supply both values, and use a production build. Also check blocking extensions, HTTPS consistency, and the website selected in Umami.

## Documentation and implementation scope

- [Product and architecture index](docs/README.md): includes early planning notes, not all of which describe implemented functionality.
- [AI connector design](docs/product/ai-connectors.md): connection and protocol adapter background.
- [Film Agent workflow](docs/product/film-agent-workflow.md): task and workflow design.
- [Runtime options](docs/architecture/runtime-options.md): discussion of static Web, optional proxies, desktop, and synchronization.
- [Frontend guidelines](.trellis/spec/frontend/index.md): conventions and module contracts.
- [Third-party notices](THIRD_PARTY_NOTICES.md): dependency, snapshot, and document-parser licensing.

The shared product runs as a static browser application and a Tauri desktop application with full SQLite/file storage. Cross-platform installer acceptance is tracked separately from implementation and local macOS checks; consult the desktop distribution guide and the actual workflow reports. Native MCP integration, server-hosted background Agent, automatic cross-device sync and real-time collaboration are not implemented capabilities. Treat current code, working UI and recorded verification as authoritative.

## Acknowledgments

Momoki builds on the work of these projects and their contributors:

| Project | Role |
| --- | --- |
| [PDF.js](https://github.com/mozilla/pdf.js), [Mammoth.js](https://github.com/mwilliamson/mammoth.js) | Local PDF and DOCX text extraction; Apache-2.0 and BSD-2-Clause respectively |
| [LobeHub](https://github.com/lobehub/lobehub) | References for Agent chat and interaction patterns |
| [Lobe UI](https://github.com/lobehub/lobe-ui), [Lobe Icons](https://github.com/lobehub/lobe-icons), [Fluent Emoji](https://github.com/lobehub/fluent-emoji) | Chat components, model branding, and emoji resources |
| [Models.dev](https://models.dev) | Model specification and pricing catalog (built-in baseline and manual sync, MIT) |
| [React](https://react.dev/), [TypeScript](https://github.com/microsoft/TypeScript) | Application UI and type system |
| [Vite](https://github.com/vitejs/vite), [Vite React Plugin](https://github.com/vitejs/vite-plugin-react) | Development server and builds |
| [TanStack Router](https://github.com/TanStack/router) | Typed routing and route generation |
| [Dexie](https://github.com/dexie/Dexie.js) | IndexedDB access and reactive data |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [tailwind-merge](https://github.com/dcastil/tailwind-merge), [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | Styling, class merging, and animation utilities |
| [Radix Primitives](https://github.com/radix-ui/primitives), [Ant Design](https://github.com/ant-design/ant-design) | Dialogs, overlays, forms, and UI primitives |
| [dnd kit](https://github.com/clauderic/dnd-kit) | Drag and drop |
| [Lucide](https://github.com/lucide-icons/lucide), [Boring Avatars](https://github.com/boringdesigners/boring-avatars) | Icons and avatars |
| [Motion](https://github.com/motiondivision/motion), [Sonner](https://github.com/emilkowalski/sonner) | Animation and notifications |
| [Class Variance Authority](https://github.com/joe-bell/cva), [clsx](https://github.com/lukeed/clsx) | Component variants and conditional classes |
| [Zod](https://github.com/colinhacks/zod), [JSZip](https://github.com/Stuk/jszip) | Validation and project ZIP archives |
| [Trellis](https://github.com/mindfold-ai/Trellis) | Development guidelines and task workflow |
| [Vitest](https://github.com/vitest-dev/vitest), [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB), [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | Tests, browser database simulation, and type declarations |

Thanks also to [APIMart](https://docs.apimart.ai/llms.txt) and [AIHubMix](https://docs.aihubmix.com/llms.txt) for the API documentation used in connector implementation.

See [`package.json`](package.json) and the lockfile for dependency versions. Each project retains its copyrights and license; acknowledgment does not relicense third-party content.

## License

Momoki's original code is licensed under the [MIT License](LICENSE).

Third-party content remains under its original terms; see [Third-party notices](THIRD_PARTY_NOTICES.md).
