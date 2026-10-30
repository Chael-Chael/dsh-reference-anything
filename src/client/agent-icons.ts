import omp from '../../images/agents/omp.svg?raw'
import copilot from '../../images/agents/copilot.svg?raw'
import doubao from '../../images/agents/doubao.svg?raw'
import type { LocalAgent } from '../wire.ts'
import antigravity from '../../images/agents/antigravity.svg?raw'
import chatgpt from '../../images/agents/chatgpt.svg?raw'
import claude from '../../images/agents/claude.svg?raw'
import cline from '../../images/agents/cline.svg?raw'
import codex from '../../images/agents/codex.svg?raw'
import continueIcon from '../../images/agents/continue.svg?raw'
import crush from '../../images/agents/crush.svg?raw'
import cursor from '../../images/agents/cursor.svg?raw'
import dsh from '../../images/agents/dsh.svg?raw'
import gemini from '../../images/agents/gemini.svg?raw'
import goose from '../../images/agents/goose.svg?raw'
import grokbuild from '../../images/agents/grokbuild.svg?raw'
import hermes from '../../images/agents/hermes.svg?raw'
import kilocode from '../../images/agents/kilocode.svg?raw'
import kimi from '../../images/agents/kimi.svg?raw'
import mimocode from '../../images/agents/mimocode.svg?raw'
import openclaw from '../../images/agents/openclaw.svg?raw'
import opencode from '../../images/agents/opencode.svg?raw'
import pi from '../../images/agents/pi.svg?raw'
import qoder from '../../images/agents/qoder.svg?raw'
import qwen from '../../images/agents/qwen.svg?raw'
import reasonix from '../../images/agents/reasonix.svg?raw'
import teleagent from '../../images/agents/teleagent.svg?raw'
import trae from '../../images/agents/trae.svg?raw'
import vibe from '../../images/agents/vibe.svg?raw'
import workbuddy from '../../images/agents/workbuddy.svg?raw'
import zcode from '../../images/agents/zcode.svg?raw'
import zed from '../../images/agents/zed.svg?raw'

export const AGENT_ICON_SVG: Readonly<Record<LocalAgent, string>> = {
  'copilot-vscode': copilot, 'copilot-cli': copilot, doubao,
  'antigravity': antigravity,
  'chatgpt': chatgpt,
  'claude-code': claude,
  'cline': cline,
  'codex': codex,
  'continue': continueIcon,
  'crush': crush,
  'cursor': cursor,
  'dsh': dsh,
  'gemini-cli': gemini,
  'goose': goose,
  'grokbuild': grokbuild,
  'hermes': hermes,
  'kilocode': kilocode,
  'kimi': kimi,
  'mimocode': mimocode,
  'openclaw': openclaw,
  'opencode': opencode,
  'pi': pi,
  'qoder': qoder,
  'qwen': qwen,
  'reasonix': reasonix,
  'teleagent': teleagent,
  'trae': trae,
  'vibe': vibe,
  'workbuddy': workbuddy,
  'zcode': zcode,
  'zed': zed,
  dsh4: dsh,
  omp,
}

// Remove upstream tile backgrounds before applying a monochrome silhouette.
export const AGENT_ICON_MONO_URI = Object.fromEntries(Object.entries(AGENT_ICON_SVG).map(([agent, svg]) => [agent,
  `data:image/svg+xml,${encodeURIComponent(svg
    .replace(/<clipPath\b[\s\S]*?<\/clipPath>|<rect (?:x="-4" y="-4" )?width="(32|512|280|30)" height="\1"[^>]*(?:\/>|><\/rect>)/g, match => match.startsWith('<clipPath') ? match : '')
    .replace(/<g filter="url\(#filter[01]_f_744_3208\)">[\s\S]*?<\/g>/g, ''))}`,
]))
