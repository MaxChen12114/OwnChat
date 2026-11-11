/* sim-kernel/graph.mjs — L1 原子·图（第五种容器）
   对标文档 §5.1：聚合层（小区网表/OD 矩阵）、车道边表、关系图共用。
   关系图不是空间图 —— 所以这是通用图（节点+边+权重+矩阵），不是"路网"专用结构。
   确定性：邻接遍历按邻居 id 升序（与插入顺序无关），同构建序列逐位一致。
   今晚只到接口+CRUD+矩阵；迭代求解（solve pass）U68 填实。 */

export function createGraph(name) {
  const nodes = new Map();                    // id -> attrs
  const adj = new Map();                      // id -> Map<nid, edgeData>（edgeData 含 len/cap/speed/…）
  const mats = new Map();                     // matName -> { data: Float32Array, rows, cols }

  function addNode(id, attrs = null) {
    if (nodes.has(id)) throw new Error(`节点重复: "${id}"`);
    nodes.set(id, attrs);
    adj.set(id, new Map());
    return id;
  }

  function addEdge(a, b, data = null, opts = {}) {
    if (a === b) throw new Error(`自环边被拒: "${a}"（区内出行走 mat 对角线，不走边）`);
    if (!nodes.has(a)) throw new Error(`边起点不存在: "${a}"`);
    if (!nodes.has(b)) throw new Error(`边终点不存在: "${b}"`);
    adj.get(a).set(b, data ? { ...data } : null);
    if (opts.twoWay) adj.get(b).set(a, data ? { ...data } : null);
  }

  /* twoWay 删除对称双向；默认只删 a→b 单向 */
  function removeEdge(a, b, opts = {}) {
    const m = adj.get(a);
    if (!m || !m.has(b)) return false;
    m.delete(b);
    if (opts.twoWay) adj.get(b)?.delete(a);
    return true;
  }

  /* 合并更新边数据（edge() 返回拷贝，外部改边数据必须走这里） */
  function setEdge(a, b, patch) {
    const m = adj.get(a);
    if (!m || !m.has(b)) return false;
    m.set(b, { ...m.get(b), ...patch });
    return true;
  }

  function removeNode(id) {
    if (!nodes.has(id)) return false;
    nodes.delete(id);
    adj.delete(id);
    for (const m of adj.values()) m.delete(id);   // 清理指向它的边
    return true;
  }

  /* 邻接遍历：按邻居 id 升序，返回 [[nid, edgeData拷贝], …] */
  function neighbors(id) {
    const m = adj.get(id);
    if (!m) throw new Error(`节点不存在: "${id}"`);
    return [...m.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map(nid => [nid, m.get(nid) ? { ...m.get(nid) } : null]);
  }

  /* 返回边数据拷贝；改边数据请用 setEdge */
  function edge(a, b) {
    const m = adj.get(a);
    const d = m && m.get(b);
    return d ? { ...d } : (m && m.has(b) ? null : null);
  }

  /* 稠密矩阵（OD、断面时间、阻抗）。行主序，与场同款 row-major 约定。
     get/set 带越界检查：Float32Array 原生越界写是静默吞掉的，这里必须炸出人话。 */
  function mat(name, rows, cols) {
    if (mats.has(name)) return mats.get(name);
    const m = {
      rows, cols,
      data: new Float32Array(rows * cols),
      get: (r, c) => {
        if (r < 0 || c < 0 || r >= rows || c >= cols) throw new RangeError(`mat "${name}" 越界 (${r},${c})，尺寸 ${rows}×${cols}`);
        return m.data[r * cols + c];
      },
      set: (r, c, v) => {
        if (r < 0 || c < 0 || r >= rows || c >= cols) throw new RangeError(`mat "${name}" 越界 (${r},${c})，尺寸 ${rows}×${cols}`);
        m.data[r * cols + c] = v;
      },
    };
    mats.set(name, m);
    return m;
  }

  return Object.freeze({
    name,
    addNode, addEdge, setEdge, removeEdge, removeNode,
    neighbors, edge,
    mat,
    has: id => nodes.has(id),
    nodeIds: () => [...nodes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    nodeAttrs: id => nodes.get(id) ?? null,
    nodeCount: () => nodes.size,
    edgeCount: () => { let s = 0; for (const m of adj.values()) s += m.size; return s; },
    matNames: () => [...mats.keys()],
  });
}
