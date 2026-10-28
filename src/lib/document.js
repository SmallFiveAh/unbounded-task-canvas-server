import { SCHEMA_VERSION } from '../config/constants.js';
import { sha256Hex } from './crypto.js';

const VIEW_MIN_SCALE = 0.2;
const VIEW_MAX_SCALE = 5;

/**
 * 视口归一化：scale 必须 clamp 到 [0.2, 5]（沿用前端 normalize.js 规则）。
 */
export function normalizeView(view) {
  if (!view || typeof view !== 'object') return null;

  const x = Number(view.x);
  const y = Number(view.y);
  const scale = Number(view.scale);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) return null;

  return {
    x,
    y,
    scale: Math.min(VIEW_MAX_SCALE, Math.max(VIEW_MIN_SCALE, scale)),
  };
}

/**
 * 整篇文档归一化。节点/连线/表格整体保留（不拆列、不改字段），
 * 只有顶层容器与视口做兜底。
 */
export function normalizeDocument(input = {}) {
  return {
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : SCHEMA_VERSION,
    nodes: Array.isArray(input.nodes) ? input.nodes : [],
    edges: Array.isArray(input.edges) ? input.edges : [],
    tables: Array.isArray(input.tables) ? input.tables : [],
    view: normalizeView(input.view),
    updatedAt: Number.isFinite(input.updatedAt) ? Math.trunc(input.updatedAt) : Date.now(),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/** 键排序后的稳定 JSON，保证相同内容得到相同 hash */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * 内容指纹：排除 updatedAt（每次保存都会变，参与计算会让「内容相同」永远不成立）。
 */
export async function computeContentHash(doc) {
  const { updatedAt: _updatedAt, ...content } = doc;
  return sha256Hex(canonicalJson(content));
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * 把归一化文档序列化为 D1 行需要的四个 JSON 列 + 体积。
 */
export function serializeDocument(doc) {
  const nodesJson = JSON.stringify(doc.nodes);
  const edgesJson = JSON.stringify(doc.edges);
  const tablesJson = JSON.stringify(doc.tables);
  const viewJson = doc.view ? JSON.stringify(doc.view) : null;

  return {
    schemaVersion: doc.version,
    nodesJson,
    edgesJson,
    tablesJson,
    viewJson,
    sizeBytes: byteLength(nodesJson) + byteLength(edgesJson) + byteLength(tablesJson),
  };
}

export function emptyDocument() {
  return normalizeDocument({ nodes: [], edges: [], tables: [], view: null });
}

/** 迁移场景：从本地存档推断任务标题（首节点文本兜底） */
export function inferTitleFromDocument(doc) {
  if (!doc) return '未命名任务';
  for (const node of doc.nodes) {
    if (node && typeof node.text === 'string' && node.text.trim()) {
      return node.text.trim().slice(0, 200);
    }
    if (node && typeof node.title === 'string' && node.title.trim()) {
      return node.title.trim().slice(0, 200);
    }
  }
  return '未命名任务';
}
