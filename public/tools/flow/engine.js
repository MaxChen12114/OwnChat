/* 代码台 · 节点引擎 (engine.js)
   框架中立的纯 JS 层:节点类型注册表 + DAG 拓扑执行器。
   不依赖 Drawflow / 任何画布库 —— 以后迁 React Flow 时这一层零改动。
   暴露 window.NodeEngine。 */
(function () {
  if (window.NodeEngine) return;

  var registry = {}; // type -> typeDef
  var groupOrder = [];

  /* typeDef = {
       type, title, group, desc,
       inputs:  [{ name, label }],
       outputs: [{ name, label }],
       params:  [{ key, label, type:'text'|'textarea'|'number'|'select', options?, placeholder?, default? }],
       run:     async (inputs, params, ctx) => outputsMap
     }
     run 收到的 inputs 是 { 端口名: 值 };返回 { 端口名: 值 }。
     ctx 提供 { chat, log, emit, signal } —— 引擎本身不碰网络,保持纯净。 */
  function register(def) {
    if (!def || !def.type) throw new Error('节点类型缺少 type');
    registry[def.type] = def;
    if (def.group && groupOrder.indexOf(def.group) < 0) groupOrder.push(def.group);
    return def;
  }

  function getType(type) { return registry[type] || null; }
  function listTypes() { return Object.keys(registry).map(function (k) { return registry[k]; }); }
  function listGroups() {
    return groupOrder.map(function (g) {
      return { group: g, types: listTypes().filter(function (t) { return t.group === g; }) };
    });
  }

  /* 拓扑排序 + 执行。
     graph = { nodes:[{id,type,params}], edges:[{from:{node,output},to:{node,input}}] }
     返回 { outputs:{nodeId:outputsMap}, order:[...], logs:[...] } */
  async function run(graph, ctx) {
    ctx = ctx || {};
    var nodes = graph.nodes || [];
    var edges = graph.edges || [];
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    var indeg = {}, adj = {};
    nodes.forEach(function (n) { indeg[n.id] = 0; adj[n.id] = []; });
    edges.forEach(function (e) {
      var f = e.from.node, t = e.to.node;
      if (byId[f] && byId[t]) { adj[f].push(t); indeg[t]++; }
    });

    var queue = [], order = [];
    nodes.forEach(function (n) { if (indeg[n.id] === 0) queue.push(n.id); });
    while (queue.length) {
      var id = queue.shift();
      order.push(id);
      adj[id].forEach(function (t) { if (--indeg[t] === 0) queue.push(t); });
    }
    if (order.length !== nodes.length) {
      throw new Error('节点图存在环路,无法执行(检查是否首尾相连)');
    }

    var incoming = {}; // nodeId -> { inputName: {node,output} }
    edges.forEach(function (e) {
      var t = e.to.node;
      (incoming[t] = incoming[t] || {})[e.to.input] = e.from;
    });

    var outputs = {};
    var logs = [];
    function log(msg) { logs.push(msg); if (ctx.log) ctx.log(msg); }

    for (var i = 0; i < order.length; i++) {
      if (ctx.signal && ctx.signal.aborted) throw new Error('已中止');
      var nid = order[i];
      var node = byId[nid];
      var def = registry[node.type];
      if (!def) { log('跳过未知节点类型:' + node.type); continue; }

      var inputs = {};
      var inc = incoming[nid] || {};
      Object.keys(inc).forEach(function (inName) {
        var src = inc[inName];
        var srcOut = outputs[src.node];
        inputs[inName] = srcOut ? srcOut[src.output] : undefined;
      });

      if (ctx.onNodeStart) ctx.onNodeStart(nid, def);
      log('▶ 执行 [' + def.title + ']');
      try {
        var res = (await def.run(inputs, node.params || {}, ctx)) || {};
        outputs[nid] = res;
        if (ctx.onNodeDone) ctx.onNodeDone(nid, res);
      } catch (err) {
        log('✕ [' + def.title + '] 出错:' + (err && err.message || err));
        if (ctx.onNodeError) ctx.onNodeError(nid, err);
        throw err;
      }
    }
    return { outputs: outputs, order: order, logs: logs };
  }

  window.NodeEngine = {
    register: register,
    getType: getType,
    listTypes: listTypes,
    listGroups: listGroups,
    run: run
  };
})();