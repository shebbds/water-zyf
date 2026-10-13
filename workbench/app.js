/* 卫生许可个人业务工作台 — 应用逻辑
 * 数据源：window.SEED_DATA（来自《zyf test.xlsx》）
 * 所有页面共享同一套本地数据（localStorage），并可选同步到腾讯云 CloudBase（文档型数据库）。
 */
(function(){
  "use strict";

  var LS_DATA = "hp_workbench_data_v2";
  var LS_SYNCED = "hp_workbench_synced_v2";
  var LS_SETTINGS = "hp_workbench_settings";
  // 内置默认配置（开箱即用；如需清除请在「设置界面」留空并保存）
  // cfgVer —— 【云端连接配置版本号】。每次更换 CloudBase 环境/集合时必须 +1。
  // 原因：localStorage 里的旧值会覆盖内置默认值，导致“在改配置之前打开过本页的设备”
  // 永远锁死在旧环境上（新旧环境并存 → 表现为“怎么都同步不了、还拉不到数据”）。
  // 版本号变大时，下面 CFG_KEYS 里的字段会被强制刷成内置值。
  var CFG_VER = 3;
  var CFG_KEYS = ["cbEnv", "cbColl", "cbRegion", "cbProxy"];
  var DEFAULT_SETTINGS = {
    cfgVer: CFG_VER,
    amapKey:"78b6849a32ebdb6c5db2371b3eb3a732",
    amapSecurity:"c930ea76af4fe01a9ab82e82ca85b3b2",
    cbEnv:"water309-d8g1c3uy074511212",   // CloudBase 环境 ID
    cbRegion:"ap-shanghai",               // 地域（必须与环境一致）
    cbColl:"water-zyf",                   // 文档集合名
    cbProxy:"/cbapi",                     // 同域代理前缀（留空则直连，依赖安全域名白名单）
    realtime:true                         // 多设备实时同步（CloudBase watch + 轮询兜底）
  };

  // 第三方库的 CDN 候选源（按顺序回退）。官方 static.cloudbase.net 为腾讯自建，
  // 国内直连最稳；jsdelivr 为国际源兜底。任一成功即可；全部失败会在页面明确告警。
  var CB_SDK_URLS = [
    "https://static.cloudbase.net/cloudbase-js-sdk/2.28.8/cloudbase.full.js",
    "https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@2.28.8/miniprogram_dist/index.js"
  ];
  var XLSX_CDNS = [
    "https://cdn.jsdmirror.com/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    "https://jsd.cdn.zzko.cn/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    "https://lib.baomitu.com/xlsx/0.18.5/xlsx.full.min.js",
    "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
    "https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js"
  ];

  // 同域代理：把 CloudBase 网关请求改写到本站点前缀（如 /cbapi），
  // 绕过免费版无法配置安全域名导致的 CORS 预检失败。仅在生产域名生效，
  // localhost / file:// 下不改写（本机已在白名单且无需代理）。
  var _cbProxyInstalled = false;
  function installCbProxy(){
    if(_cbProxyInstalled) return; _cbProxyInstalled = true;
    function rewrite(u){
      var env = (state.settings.cbEnv||"").trim();
      var region = (state.settings.cbRegion||"ap-shanghai").trim();
      var proxy = (state.settings.cbProxy||"").trim();
      if(!env || !proxy) return u;
      if(typeof u !== "string" || !/^https?:\/\//.test(u)) return u;
      if(location.hostname==="localhost" || location.hostname==="127.0.0.1" || location.protocol==="file:") return u;
      var host = env + "." + region + ".tcb-api.tencentcloudapi.com";
      var i = u.indexOf(host);
      if(i < 0) return u;
      return location.origin + proxy + u.slice(i + host.length);
    }
    var of = window.fetch ? window.fetch.bind(window) : null;
    if(of){ window.fetch = function(u, o){ return of(rewrite(typeof u==="string"?u:(u&&u.url||u)), o); }; }
    var ox = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u, a){ return ox.call(this, m, rewrite(u), a); };
    if(window.WebSocket){
      var _WS = window.WebSocket;
      var W = function(url, proto){ return new _WS(rewrite(url), proto); };
      W.prototype = _WS.prototype;
      W.CONNECTING=_WS.CONNECTING; W.OPEN=_WS.OPEN; W.CLOSING=_WS.CLOSING; W.CLOSED=_WS.CLOSED;
      window.WebSocket = W;
    }
  }

  var state = {
    data: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    view: "home",
    homeWindow: 30,
    selected: {},          // uid -> true
    synced: {},           // license -> true：已知存在于云端的许可证号（用于区分“本地新增”与“别处已删除”）
    _cbId: {},            // license -> CloudBase 文档 _id（upsert/delete 时定位文档，pull 时重建）
    amap: null,
    geocoder: null,
    amapReady: false,
    markers: {},           // uid -> AMap.Marker
    pickMode: false,        // 地图手动选点模式
    pickTarget: null,       // 选点目标单位 uid
    searchActive: false,    // 是否处于搜索高亮状态
    searchMatches: {},      // uid -> true（搜索命中集合）
    searchJustRan: false,   // 本次搜索刚触发（用于播放一次跳动）
    mapQuery: "",           // 地图当前搜索词
    ledgerQuery: "",        // 台账搜索词
    targetUid: null,        // 地图当前选中的目标单位（红色高亮 + 周边单位锚点）
    targetCircles: [],      // 当前距离圆（AMap.Circle，只保留“选定/自定义”那一个）引用，便于清理
    targetRadius: 200,      // 当前“周围单位”半径（米）
    _clickTimer: null,      // 标记单击延时器（用于区分单击 / 双击）
    _lastClickUid: null,    // 上一次点击的标记 uid（双击判定）
    _lastClickTs: 0,        // 上一次点击时间戳
    _markerClickTs: 0,      // 标记点击时间戳（防地图冒泡误清空）
    _detailOpenTs: 0,       // 详情弹窗最近打开时间（防多条事件路径重复弹窗）
    _nbTimer: null,         // 周围单位列表单击延时器（区分单击 / 双击）
    _nbUid: null,           // 上一次点击的周围单位 uid
    _nbTs: 0,               // 上一次点击时间戳
    _nbDblTs: 0,            // 最近一次双击触发时间（防 click+dblclick 双路径重复切换）
    _flashTimer: null,      // 橙色跳动复位计时器
    _unlocSig: ""           // 待编码单位集合签名（避免列表无谓重建、丢失滚动位置）
  };

  /* ---------------- 工具函数 ---------------- */
  function uid(){ return "u" + Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
  function $(id){ return document.getElementById(id); }
  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }

  function iso(d){
    return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
  }
  function parseDate(s){
    if(!s) return null;
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return null;
    return new Date(+m[1], +m[2]-1, +m[3]);
  }
  // 有效期止 = 所选日期 + 4 年 - 1 天
  function calcValidTo(fromStr){
    var d = parseDate(fromStr);
    if(!d) return "";
    var nd = new Date(d.getFullYear()+4, d.getMonth(), d.getDate());
    nd.setDate(nd.getDate()-1);
    return iso(nd);
  }
  function daysUntil(s){
    var d = parseDate(s);
    if(!d) return null;
    var t = new Date(); t.setHours(0,0,0,0);
    return Math.round((d - t) / 86400000);
  }
  function normDateStr(v){
    v = String(v==null?"":v).trim();
    if(!v) return "";
    var m = v.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
    if(m) return iso(new Date(+m[1], +m[2]-1, +m[3]));
    return v;
  }
  function normExcelDate(v){
    if(v==null || v==="") return "";
    if(v instanceof Date) return iso(v);
    if(typeof v === "number"){
      // Excel 序列号（1900 日期系统）
      var d = new Date((v - 25569) * 86400000);
      return isNaN(d) ? "" : iso(d);
    }
    return normDateStr(v);
  }
  function nextId(){
    var max = 0;
    state.data.forEach(function(r){
      var n = parseInt(r.id, 10);
      if(!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }
  function coordText(r){
    return (r.lng!=null && r.lat!=null) ? (r.lng.toFixed(5)+", "+r.lat.toFixed(5)) : "未编码";
  }

  /* ---------------- 持久化 ---------------- */
  function loadSettings(){
    // 内置默认（含密钥）作为基础值，仅当用户在某字段填了非空值时才覆盖；
    // 空值不再清空密钥，避免“先存了部分配置”导致后续密钥无法生效。
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    var upgraded = false;
    try{
      var raw = localStorage.getItem(LS_SETTINGS);
      if(raw){
        var parsed = JSON.parse(raw);
        Object.keys(parsed).forEach(function(k){
          if(parsed[k] !== undefined && parsed[k] !== "") state.settings[k] = parsed[k];
        });
        // 【配置升级】本地存的云端配置版本低于内置版本 → 说明内置的 CloudBase
        // 环境已更换，而本设备还锁在旧环境上（旧环境往往仍然存活，
        // 于是读写都“看起来正常”，实际和别的设备根本不是一个环境）。
        // 此时强制把 CFG_KEYS 刷成内置值，避免继续静默写进废弃的环境。
        var storedVer = Number(parsed.cfgVer || 0);
        if(storedVer < CFG_VER){
          CFG_KEYS.forEach(function(k){ state.settings[k] = DEFAULT_SETTINGS[k]; });
          state.settings.cfgVer = CFG_VER;
          upgraded = true;
        }
      } else {
        // 首次运行：把内置默认（含密钥）固化到本地，真正“配置进去”
        saveSettingsLocal();
      }
      if(upgraded){
        saveSettingsLocal();
        state._cfgUpgraded = true;   // 供启动后提示用户“云端地址已自动更新”
      }
    }catch(e){}
  }
  function saveSettingsLocal(){
    localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings));
  }
  function loadData(){
    var raw = localStorage.getItem(LS_DATA);
    if(raw){
      try{ state.data = JSON.parse(raw); }catch(e){ state.data = []; }
    }
    try{ var s = localStorage.getItem(LS_SYNCED); state.synced = s ? JSON.parse(s) : {}; }catch(e){ state.synced = {}; }
    // 云端配置刚被强制升级（换了 CloudBase 环境）→ 旧的 synced 标记属于【另一个环境】，
    // 若保留，合并逻辑会把“新环境里没有、但在旧环境里同步过”的本地记录当成
    // “已被其它设备删除”而误删。清空后首次合并退化为纯增量：只增不删，最安全。
    if(state._cfgUpgraded){ state.synced = {}; saveSynced(); }
    // 仅在【首次安装、从未保存过】（LS_DATA 键不存在）时才载入种子数据；
    // 用户主动删空（LS_DATA = "[]"）时绝不能重置，否则永远删不干净。
    if(!raw){
      state.data = (window.SEED_DATA||[]).map(function(r){
        return Object.assign({}, r, { _uid: uid(), remark:(r.remark||""),
          deviceType:(r.deviceType||""), contact:(r.contact||"") });
      });
      saveDataLocal();
    } else if(state.data && state.data.length){
      state.data.forEach(function(r){
        if(!r._uid) r._uid = uid();
        if(r.remark===undefined) r.remark="";
        if(r.deviceType===undefined) r.deviceType="";
        if(r.contact===undefined) r.contact="";
      });
    }
  }
  function saveSynced(){ try{ localStorage.setItem(LS_SYNCED, JSON.stringify(state.synced||{})); }catch(e){} }
  function markAllSynced(){ state.data.forEach(function(r){ if(r.license) state.synced[r.license] = true; }); saveSynced(); }
  function saveDataLocal(){ localStorage.setItem(LS_DATA, JSON.stringify(state.data)); saveSynced(); }
  function saveData(sync){
    saveDataLocal();
    if(sync !== false) scheduleSync();
  }

  /* ---------------- 云端异常提示条 ----------------
   * CloudBase 的云调用常常“resolve 一个错误对象”而非 reject，且写权限被拒时
   * 静默返回 {updated:0}/{deleted:0}（无任何 error）。故所有云调用必须过
   * unwrap（捕获 {code} 错误）与 mustAffect（捕获“影响 0 条”的静默失败）。
   */
  // 自检探针用的许可证号（__probe__ / __rt_probe__），永远不会进入界面
  function isProbeLicense(l){ return /^__/.test(String(l || "")); }

  function showCloudAlert(level, html){
    var box = $("cloud-alert");
    if(!box) return;
    box.className = "cloud-alert" + (level === "warn" ? " warn" : "");
    box.innerHTML = '<div class="ca-body">'+html+'</div>' +
      '<div class="ca-actions">' +
        '<button class="btn sm" id="ca-copy">复制规则</button>' +
        '<button class="btn sm" id="ca-close">知道了</button>' +
      '</div>';
    box.style.display = "flex";
    var cp = $("ca-copy");
    if(cp) cp.addEventListener("click", function(){
      var txt = '{"read":true,"write":true}';
      try{
        if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt); }
        else { var ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
        toast("安全规则已复制：{\"read\":true,\"write\":true}，去 CloudBase 控制台粘贴", "ok");
      }catch(e){ toast("复制失败，请手动复制", "warn"); }
    });
    var cl = $("ca-close");
    if(cl) cl.addEventListener("click", function(){ hideCloudAlert(); });
  }
  function hideCloudAlert(){
    var box = $("cloud-alert");
    if(box){ box.style.display = "none"; box.innerHTML = ""; }
  }
  // 云端错误 → 常驻提示条（必须让用户看到并修）
  function showCloudError(detail){
    showCloudAlert("err",
      '<b>⚠️ 云端操作失败（数据仅存本地）</b><br>' +
      '常见原因：集合安全规则未放开写权限、集合不存在、或环境 ID 错误。<br>' +
      '请确认 CloudBase 控制台 → 文档型数据库 → 集合 <b>'+esc(cbColl())+'</b> 的权限规则为 <code>{"read":true,"write":true}</code>。' +
      (detail ? '<br><span style="opacity:.75">云端返回：'+esc(detail)+'</span>' : ''));
  }
  function isPermissionErr(msg){
    return /PERMISSION|COLLECTION_NOT_EXIST|DATABASE_PERMISSION|Unauthenticated|无权限/i.test(String(msg||""));
  }
  // CloudBase 错误常以 {code,message} 形式 resolve（而非 reject）
  function unwrap(res, what){
    if(res && typeof res === "object" && res.code){
      var e = new Error((what ? what + "：" : "") + (res.message || res.code));
      e.code = res.code; throw e;
    }
    return res;
  }
  // 捕获“静默失败”：写被拒时返回 {id:""}/{updated:0}/{deleted:0}，必须当错误处理
  function mustAffect(res, what){
    res = unwrap(res, what);
    if(res && typeof res.id === "string"){ if(!res.id) throw new Error((what||"写入云端")+"：被拒绝（无权限），请检查集合安全规则是否为 read/write 全开"); return res; }
    if(res && Array.isArray(res.ids)){ if(!res.ids.length) throw new Error((what||"写入云端")+"：被拒绝（无权限），请检查集合安全规则"); return res; }
    if(res && typeof res.updated === "number" && res.updated === 0) throw new Error((what||"更新云端")+"：影响 0 条（无权限），请检查集合安全规则");
    if(res && typeof res.deleted === "number" && res.deleted === 0) throw new Error((what||"删除云端")+"：影响 0 条（无权限），请检查集合安全规则");
    return res;
  }

  /* ---------------- 云同步（CloudBase） ---------------- */
  function cbColl(){ return state.settings.cbColl || "water-zyf"; }
  function cbUnavailableMsg(){
    if(!state.settings.cbEnv) return "请先在设置中配置 CloudBase 环境 ID";
    if(!window.cloudbase) return "CloudBase 同步库尚未加载完成（可能被网络拦截），请稍候或刷新页面重试";
    return "CloudBase 客户端不可用";
  }
  var _cbApp = null, _cbDb = null, _cbInit = null;
  function resetCb(){ _cbApp = null; _cbDb = null; _cbInit = null; state._cbId = {}; }
  async function ensureCb(){
    if(_cbDb) return _cbDb;
    if(!state.settings.cbEnv) throw new Error("未配置 CloudBase 环境 ID");
    if(!window.cloudbase) throw new Error("CloudBase 同步库未加载");
    if(_cbInit) return _cbInit;
    _cbInit = (async function(){
      var app = window.cloudbase.init({ env: state.settings.cbEnv, region: state.settings.cbRegion || "ap-shanghai" });
      var auth = app.auth;
      if(typeof auth === "function"){ try{ auth = auth({ persistence:"local" }); }catch(e){} }
      await auth.signInAnonymously();
      _cbApp = app; _cbDb = app.database();
      return _cbDb;
    })();
    try{ return await _cbInit; }
    catch(e){ _cbInit = null; throw e; }
  }
  function toRows(){
    return state.data.map(function(r){
      return {
        license:r.license, id:r.id, name:r.name, address:r.address,
        valid_from:r.validFrom, valid_to:r.validTo, lng:r.lng, lat:r.lat,
        remark:(r.remark==null?"":r.remark),
        device_type:(r.deviceType==null?"":r.deviceType),
        contact:(r.contact==null?"":r.contact)
      };
    });
  }
  // 判断本地行与云端文档是否已一致（用于跳过“无需变更”的更新）。
  // 关键：CloudBase 的 doc(_id).update() 在“匹配到但内容没变”时返回 updated:0，
  // 这和“无权限被拒”不是一回事；直接把它当失败会在整批重新上传时误报“影响 0 条（无权限）”。
  function sameRow(row, d){
    if(!d) return false;
    var f = ["license","id","name","address","valid_from","valid_to","lng","lat","remark","device_type","contact"];
    for(var i=0;i<f.length;i++){
      var a = row[f[i]], b = d[f[i]];
      if(a===null || a===undefined) a = "";
      if(b===null || b===undefined) b = "";
      if(typeof a === "number") a = String(a);
      if(typeof b === "number") b = String(b);
      if(String(a) !== String(b)) return false;
    }
    return true;
  }
  // 读全量集合（SDK 分页透明：skip 正确映射为 offset），返回文档数组
  async function fetchAll(coll){
    var all = [], offset = 0;
    while(true){
      var page = unwrap(await coll.skip(offset).limit(100).get(), "读取云端失败");
      var arr = page.data || [];
      for(var i=0;i<arr.length;i++) all.push(arr[i]);
      if(arr.length < 100) break;
      offset += arr.length;
    }
    return all;
  }
  // 静默自动同步失败也要让用户看见，否则“保存失败”被完全吞掉
  var _syncErrAt = {};
  function warnSyncError(msg){
    var key = String(msg).slice(0,80);
    var now = Date.now();
    if(_syncErrAt[key] && now-_syncErrAt[key]<60000) return;
    _syncErrAt[key]=now;
    if(isPermissionErr(msg)) showCloudError(msg);
    toast("云端保存失败（数据仅存本地）："+msg, "err");
  }
  /* ---------------- 全量云操作互斥门（性能护栏，别删） ----------------
   * 一次全量操作会发起上百次 /cbapi 请求。经同域代理单次往返实测约 500ms，
   * 且 SDK 内部把请求串行化（实测 10 条并发写 8298ms vs 逐条 4980ms，并发无收益）。
   * 所以「少发请求」是唯一的有效手段；叠加执行更是灾难：
   * 旧版 pushCloud 对 191 行逐条 update、每条 updated:0 还要再读回一次（382 次请求），
   * 实测耗时 313 秒，期间整页完全失去响应（CDP Runtime.evaluate 连续 6 次 5 秒无响应）。
   * 这里保证同一时刻只有一个全量操作在跑，后来的合并成“跑完再补一次”。
   */
  var _cloudGate = null;      // null | "push" | "align" | "pull"
  var _cloudPending = null;   // null | "align" | "pull"
  function cloudGateFree(){
    _cloudGate = null;
    var p = _cloudPending; _cloudPending = null;
    if(!p) return;
    setTimeout(function(){
      if(p === "align") syncNow({silent:true});
      else pullCloud({confirm:false, merge:true, quietError:true, silent:true});
    }, 0);
  }
  async function pushCloud(silent){
    if(_cloudGate){
      if(!silent) toast("云端同步正在进行，请稍候再试", "warn");
      return;
    }
    _cloudGate = "push";
    try{
      var db;
      try{ db = await ensureCb(); }catch(e){ if(!silent) toast(cbUnavailableMsg(),"warn"); return; }
      var coll = db.collection(cbColl());
      // 先读云端全量：既拿到 license→_id 映射，也比对出「无需变更」的行。
      // ⚠️ 这一步是性能关键：跳过未变更行后，日常上传从 382 次请求降到 2 次。
      var all = await fetchAll(coll);
      var cloudById = {}, cloudDoc = {};
      all.forEach(function(d){ if(d && d.license){ cloudById[d.license] = d._id; cloudDoc[d.license] = d; } });
      state._cbId = Object.assign({}, state._cbId, cloudById);
      var rows = toRows();
      var todo = [];
      rows.forEach(function(row){
        if(!row.license) return;                     // 无许可证号无法定位文档，跳过（否则每次都会重复新增）
        var id = cloudById[row.license];
        if(!id){ todo.push({ row:row, add:true }); return; }
        if(sameRow(row, cloudDoc[row.license])) return;   // 与云端一致 → 不发请求
        todo.push({ row:row, id:id });
      });
      for(var i=0;i<todo.length;i++){
        var it = todo[i];
        if(it.add){
          var r = mustAffect(unwrap(await coll.add(it.row), "写入云端失败 license="+it.row.license), "写入云端失败");
          if(r.id) state._cbId[it.row.license] = r.id;
        } else {
          var u = unwrap(await coll.doc(it.id).update(it.row), "更新云端失败 license="+it.row.license);
          if(u && typeof u.updated === "number" && u.updated === 0){
            // updated:0 = 匹配到文档但内容没变（无需变更）时也会出现，不能当成“无权限”。
            // 读回该条与本地比对：一致=成功；不一致=真的没生效（无权限/已被删）→ 报错。
            var chk = unwrap(await coll.doc(it.id).get(), "读取云端失败");
            var d = (chk && chk.data) ? (Array.isArray(chk.data) ? chk.data[0] : chk.data) : null;
            if(!d || !sameRow(it.row, d)) throw new Error("更新云端失败 license="+it.row.license+"：云端未生效（无权限或已被删除），请检查集合安全规则");
          }
        }
      }
      markAllSynced();
      if(!silent) toast(todo.length
        ? ("已上传 "+rows.length+" 条到云端（其中 "+todo.length+" 条有变更）")
        : ("云端已是最新（"+rows.length+" 条，无需上传）"), "ok");
    }catch(e){
      var m = e.message || String(e);
      if(isPermissionErr(m)) showCloudError(m);
      if(!silent) toast("上传失败："+m, "err");
      else warnSyncError(m);
    }finally{
      cloudGateFree();
    }
  }
  async function deleteCloud(licenses, silent){
    if(!licenses || !licenses.length) return;
    var db;
    try{ db = await ensureCb(); }catch(e){ if(!silent) toast(cbUnavailableMsg(),"warn"); return; }
    try{
      var coll = db.collection(cbColl());
      for(var i=0;i<licenses.length;i++){
        var id = state._cbId[licenses[i]];
        if(!id){
          var g = unwrap(await coll.where({license:licenses[i]}).limit(1).get(), "查询云端失败");
          if(g.data && g.data[0]) id = g.data[0]._id;
        }
        if(id){ mustAffect(unwrap(await coll.doc(id).remove(), "删除云端失败"), "删除云端失败"); delete state._cbId[licenses[i]]; }
      }
      if(!silent) toast("已从云端删除 "+licenses.length+" 条", "ok");
    }catch(e){
      if(!silent) toast("云端删除失败："+(e.message||e), "err");
    }
  }
  var syncTimer = null;
  function scheduleSync(){
    if(syncTimer) clearTimeout(syncTimer);
    // 用 syncNow（先比对、跳过未变更行）而不是 pushCloud：
    // 导入/编码结束时这里会被触发，旧版走 pushCloud 会逐条重传全部记录，
    // 实测 191 条耗时 313 秒并卡死整页。syncNow 在无变化时只需 2 次请求。
    syncTimer = setTimeout(function(){ syncTimer = null; syncNow({silent:true}); }, 1500);
  }

  /* ---------------- 即时全量对齐（台账操作后调用） ----------------
   * 与 scheduleSync（1.5s 防抖、只 upsert）不同：syncNow 立即执行，
   * 且让【云端与本地完全一致】——新增/编辑=upsert，本地已删=从云端删除。
   */
  var _aligning = false, _alignPending = false;
  async function syncNow(opts){
    opts = opts || {};
    if(_aligning || (_cloudGate && _cloudGate !== "align")){ _alignPending = true; return; }
    _aligning = true; _cloudGate = "align";
    try{
      var db;
      try{ db = await ensureCb(); }catch(e){ if(!opts.silent) toast("请先在设置中配置 CloudBase","warn"); return; }
      var coll = db.collection(cbColl());
      // 1) 读取云端全量，建立 license→_id / license→文档 映射（供后续 upsert/delete 用）
      var all = await fetchAll(coll);
      var cloudById = {}; var cloudLic = {}; var cloudDoc = {};
      all.forEach(function(d){ if(d && d.license){ cloudById[d.license]=d._id; cloudLic[d.license]=true; cloudDoc[d.license]=d; } });
      state._cbId = cloudById;
      // 2) 上传本地全部记录：与云端一致的直接跳过（否则 doc().update() 对未变更文档返回
      //    updated:0，会被误判为“无权限”而中断整批同步）；确有变化的才发送更新。
      //    注意：这里刻意保持【逐条串行】——实测经 /cbapi 代理并发写反而更慢（见互斥门注释）。
      var rows = toRows();
      for(var i=0;i<rows.length;i++){
        var row = rows[i];
        if(!row.license) continue;                 // 无许可证号无法定位文档，跳过（避免重复新增）
        var id = cloudById[row.license];
        if(id){
          if(cloudDoc[row.license] && sameRow(row, cloudDoc[row.license])) continue;
          mustAffect(unwrap(await coll.doc(id).update(row), "更新云端失败 license="+row.license), "更新云端失败");
        }
        else { var r = mustAffect(unwrap(await coll.add(row), "写入云端失败 license="+row.license), "写入云端失败"); if(r.id) cloudById[row.license] = r.id; }
      }
      // 3) 删除云端残留：只删「本设备曾同步过(state.synced)、但本地现已没有」的记录
      var localLic = {};
      state.data.forEach(function(r){ if(r.license) localLic[r.license] = true; });
      var stale = Object.keys(cloudLic).filter(function(l){ return !localLic[l] && state.synced[l]; });
      var guard = "";
      if(!state.data.length && Object.keys(cloudLic).length){
        guard = "本地没有任何记录，却要删除云端 " + stale.length + " 条";
      } else if(stale.length > 10 && state.data.length*3 < Object.keys(cloudLic).length){
        guard = "本地仅 " + state.data.length + " 条、云端 " + Object.keys(cloudLic).length +
                " 条，待删 " + stale.length + " 条异常偏多";
      }
      if(guard){
        stale = [];
        showCloudAlert("warn",
          '<b>⚠️ 已阻止一次可能误删云端数据的操作</b><br>'+esc(guard)+'。<br>' +
          '这通常说明本设备的数据不完整，或连到了<b>另一个 CloudBase 环境</b>。' +
          '请到「设置界面」确认<b>当前连接的环境 ID</b>是否正确，再点「从云端拉取」对齐后再继续。');
      }
      if(stale.length){
        for(var j=0;j<stale.length;j++){
          var sid = cloudById[stale[j]];
          if(sid){ mustAffect(unwrap(await coll.doc(sid).remove(), "删除云端失败"), "删除云端失败"); delete state._cbId[stale[j]]; }
        }
      }
      markAllSynced();
      if(!opts.silent){
        var extra = [];
        if(stale.length) extra.push("同步删除 " + stale.length + " 条");
        toast("已与云端对齐：" + state.data.length + " 条" + (extra.length ? "（" + extra.join("；") + "）" : ""), "ok");
      }
    }catch(e){
      var m = e.message || String(e);
      if(!opts.silent) toast("云端对齐失败："+m, "err");
      else warnSyncError(m);
    }finally{
      _aligning = false;
      cloudGateFree();
      if(_alignPending){ _alignPending = false; syncNow(opts); }
    }
  }
  // 台账操作后的统一提交：立即落盘 + 立即与云端对齐
  function commit(opts){ saveDataLocal(); syncNow(opts); }

  /* ---------------- 多设备实时同步（CloudBase watch + 轮询兜底） ---------------- */
  var rtWatcher = null, rtPollTimer = null, rtTimer = null, rtState = "off";   // off|connecting|on|error
  var rtEventCount = 0;        // 实际收到过多少次变更推送（判断“真连通”而非“假订阅”）
  var rtLastEventAt = 0;
  function updateRtBadge(){
    var el = $("rt-badge");
    if(!el) return;
    var txt = rtState === "on" ? (rtEventCount > 0 ? "实时同步：已连接（已验证）" : "实时同步：已连接（尚未验证）")
            : rtState === "connecting" ? "实时同步：连接中…"
            : rtState === "error" ? "实时同步：未生效（轮询兜底中）"
            : "实时同步：未启用";
    if(state.settings.realtime === false && rtState === "off") txt = "实时同步：已关闭";
    el.textContent = txt;
    el.className = "rt-badge " + rtState;
    el.title = rtEventCount > 0
      ? ("已收到 " + rtEventCount + " 次云端变更推送，最近一次 " + new Date(rtLastEventAt).toLocaleTimeString())
      : "尚未收到任何云端变更推送。若长时间如此，请到「设置界面」点「📡 检查实时同步」。";
  }
  // 实时推送未真正生效（代理可能不支持 WebSocket）→ 提示并依赖轮询兜底
  function showRealtimeAlert(detail){
    showCloudAlert("warn",
      '<b>⚠️ 实时推送未生效（其它设备的改动约每 30 秒自动同步一次）</b><br>' +
      '已启用定时轮询兜底，功能不受影响，只是不是“瞬时”。' +
      '若需要真正的实时推送，请确认同域代理（/cbapi）支持 WebSocket 升级。' +
      (detail ? '<br><span style="opacity:.75">云端返回：'+esc(detail)+'</span>' : ''));
  }
  // 收到变更事件后防抖拉取；若本端正上传，稍后再拉，避免与 syncNow 打架
  function scheduleRealtimePull(){
    if(rtTimer) clearTimeout(rtTimer);
    rtTimer = setTimeout(function(){
      rtTimer = null;
      if(_aligning){ scheduleRealtimePull(); return; }
      pullCloud({ confirm:false, merge:true, quietError:true, silent:true });
    }, 600);
  }
  // 轮询兜底：watch 12 秒未收到事件 / 出错时启用（约每 30 秒一次）
  function startFallbackPoll(){
    if(rtPollTimer) return;
    rtPollTimer = setInterval(function(){
      if(_aligning) return;
      if(rtEventCount > 0) return;   // 已通过 watch 收到过事件 → 不需要轮询
      pullCloud({ confirm:false, merge:true, quietError:true, silent:true });
    }, 30000);
  }
  function startRealtime(){
    if(state.settings.realtime === false){ stopRealtime(); rtState = "off"; updateRtBadge(); return; }
    if(rtWatcher) return;
    ensureCb().then(function(db){
      rtState = "connecting"; updateRtBadge();
      var coll = db.collection(cbColl());
      try{
        rtWatcher = coll.watch({
          onChange: function(){
            rtEventCount++; rtLastEventAt = Date.now(); rtState = "on"; updateRtBadge();
            scheduleRealtimePull();
          },
          onError: function(e){ rtState = "error"; updateRtBadge(); startFallbackPoll(); }
        });
      }catch(e){ rtState = "error"; updateRtBadge(); }
      // watch 12 秒内未收到任何事件 → 启动轮询兜底（代理可能不支持 WebSocket）
      setTimeout(function(){
        if(rtEventCount === 0 && rtState !== "error" && !rtPollTimer) startFallbackPoll();
      }, 12000);
    }).catch(function(e){
      rtState = "error"; updateRtBadge(); startFallbackPoll();
    });
  }
  function stopRealtime(){
    if(rtPollTimer){ clearInterval(rtPollTimer); rtPollTimer = null; }
    if(rtTimer){ clearTimeout(rtTimer); rtTimer = null; }
    if(rtWatcher){ try{ rtWatcher.close(); }catch(e){} rtWatcher = null; }
  }
  /* 数据指纹：用于判断一次拉取是否真的改变了要渲染的内容。
   * 实时推送/轮询会频繁触发 pullCloud，若无变化还整页重绘（地图视图还会重建
   * 上百个标记），就会出现“什么都没变却在卡”的怪象。 */
  function dataSig(){
    var h = 0, s;
    for(var i=0;i<state.data.length;i++){
      var r = state.data[i];
      s = r._uid + "|" + r.id + "|" + r.name + "|" + r.address + "|" + r.license + "|" +
          r.validFrom + "|" + r.validTo + "|" + r.lng + "|" + r.lat + "|" +
          r.remark + "|" + r.deviceType + "|" + r.contact;
      for(var j=0;j<s.length;j++){ h = (h * 31 + s.charCodeAt(j)) | 0; }
    }
    return state.data.length + ":" + h;
  }
  /* 渲染合并：同一帧内多次请求只重绘一次（同步/拉取/实时推送都会调它） */
  var _renderQueued = false;
  function renderCurrentViewSoon(){
    if(_renderQueued) return;
    _renderQueued = true;
    setTimeout(function(){ _renderQueued = false; switchView(state.view); }, 0);
  }
  // 从云端拉取。opts: { confirm:是否先确认覆盖, merge:按许可证号合并(保留本地独有记录、坐标不空覆盖),
  //                  quietError:静默错误提示, silent:静默全部提示 }
  async function pullCloud(opts){
    opts = opts || {};
    if(_cloudGate){ _cloudPending = _cloudPending || "pull"; return false; }
    if(opts.confirm !== false && opts.merge !== true){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return false;
    }
    _cloudGate = "pull";
    try{
      var db;
      try{ db = await ensureCb(); }catch(e){ if(!opts.silent) toast("请先在设置中配置 CloudBase","warn"); return false; }
      var sig0 = dataSig();
      var coll = db.collection(cbColl());
      var all = await fetchAll(coll);
      // 过滤探针记录（正常已即时删除）
      var rows = all.filter(function(d){ return !isProbeLicense(d.license); });
      // 建立 license→_id 映射（供后续 upsert/delete 用）
      state._cbId = {};
      rows.forEach(function(d){ if(d && d.license) state._cbId[d.license] = d._id; });
      if(opts.merge === true){
        var cloudLicenses = {};
        rows.forEach(function(d){ cloudLicenses[d.license] = true; });
        // 仅删除“曾在云端(state.synced)、但云端现已没有”的本地记录 = 其它设备的删除已传播；
        // 从未推上云端的本地新增（不在 synced）不会被误删。云端被删空时也会剪枝。
        if(rows.length > 0 || Object.keys(state.synced).length > 0){
          state.data = state.data.filter(function(r){
            return !r.license || !state.synced[r.license] || cloudLicenses[r.license];
          });
        }
        var byLicense = {};
        state.data.forEach(function(r){ if(r.license) byLicense[r.license] = r; });
        rows.forEach(function(d){
          var base = byLicense[d.license];
          if(base){
            base.id = d.id; base.name = d.name; base.address = d.address;
            base.validFrom = d.valid_from; base.validTo = d.valid_to;
            if(d.remark != null) base.remark = d.remark;
            if(d.device_type != null) base.deviceType = d.device_type;
            if(d.contact != null) base.contact = d.contact;
            if(d.lng != null) base.lng = d.lng;
            if(d.lat != null) base.lat = d.lat;
          } else {
            state.data.push({ _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
              validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat,
              remark:(d.remark==null?"":d.remark), deviceType:(d.device_type==null?"":d.device_type), contact:(d.contact==null?"":d.contact) });
          }
          if(d.license) state.synced[d.license] = true;
        });
        saveSynced();
      } else {
        state.data = rows.map(function(d){
          return { _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
            validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat,
            remark:(d.remark==null?"":d.remark), deviceType:(d.device_type==null?"":d.device_type), contact:(d.contact==null?"":d.contact) };
        });
        state.synced = {};
        rows.forEach(function(d){ if(d.license) state.synced[d.license] = true; });
        saveSynced();
      }
      saveDataLocal();
      // 只有内容真的变了才重绘；无变化时跳过（避免同步过程中反复重建地图标记）
      if(dataSig() !== sig0) renderCurrentViewSoon();
      if(rows.length && !opts.silent) toast("已从云端同步 "+rows.length+" 条"+(opts.merge?"（已与本地合并）":""), "ok");
      if(!rows.length && !state.data.length){
        showCloudAlert("warn",
          '<b>云端返回 0 条记录，本地也没有数据，所以页面是空的。</b><br>' +
          '如果你确认云端原本存有数据，通常是集合 <b>'+esc(cbColl())+'</b> 的权限规则未放开读，' +
          '或环境 ID 填错。请到 CloudBase 控制台确认集合权限为 <code>{"read":true,"write":true}</code>，' +
          '然后按 <b>Ctrl+Shift+R</b> 刷新。若你只是首次使用，可先在「单位台账」导入 Excel。');
      }
      return true;
    }catch(e){
      var m = e.message || String(e);
      if(isPermissionErr(m)) showCloudError(m);
      if(!opts.quietError && !opts.silent) toast("拉取失败："+m, "err");
      return false;
    }finally{
      cloudGateFree();
    }
  }

  /* ---------------- 云端配置升级提示 ---------------- */
  function showCfgUpgradeNotice(){
    var env = String(state.settings.cbEnv || "");
    showCloudAlert("warn",
      '<b>ℹ️ 云端地址已自动更新</b><br>' +
      '本设备保存的云端配置版本较旧（可能仍指向已停用的环境），已自动切换为当前内置环境：<br>' +
      '<code>'+esc(env)+'</code><br>' +
      '正在从新云端合并数据（只增不删，本地数据不会被清空）。' +
      '若发现与其它设备数据不一致，请到「设置界面」点「从云端拉取」。');
  }

  /* ---------------- 高德地图 ---------------- */
  function loadAmapScript(key, security){
    return new Promise(function(resolve, reject){
      if(window.AMap){ resolve(); return; }
      window._AMapSecurityConfig = { securityJsCode: security || "" };
      var s = document.createElement("script");
      s.src = "https://webapi.amap.com/maps?v=2.0&key=" + encodeURIComponent(key) +
              "&plugin=AMap.Geocoder,AMap.ToolBar,AMap.Scale";
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error("脚本加载失败（检查网络或密钥）")); };
      document.head.appendChild(s);
    });
  }
  var amapLoading = null;   // 共享加载 Promise：并发调用只注入一次 SDK
  function ensureAmap(){
    if(state.amapReady) return Promise.resolve(true);
    if(!state.settings.amapKey) return Promise.resolve(false);
    if(amapLoading) return amapLoading;
    amapLoading = loadAmapScript(state.settings.amapKey, state.settings.amapSecurity)
      .then(function(){
        state.geocoder = new window.AMap.Geocoder({ city:"北京", citylimit:false });
        state.amapReady = true;
        amapLoading = null;
        return true;
      })
      .catch(function(e){
        amapLoading = null;
        toast("高德地图加载失败：" + e.message, "err");
        return false;
      });
    return amapLoading;
  }
  function initMap(){
    var el = $("amap-container");
    if(!state.amap){
      // doubleClickZoom:false —— 双击留给“打开单位详情”，避免高德双击缩放抢占事件
      state.amap = new window.AMap.Map(el, { zoom:12, center:[116.41,39.95], doubleClickZoom:false });
      state.amap.addControl(new window.AMap.ToolBar());
      state.amap.addControl(new window.AMap.Scale());
      state.amap.on("click", onMapClick);   // 仅在地图创建时绑定一次，避免重复监听
      // 兜底①：DOM 级双击监听。不依赖高德 SDK 是否代理 marker 的 dblclick 事件，
      // 只要双击落在标记圆点（.mk-dot）上就打开详情，稳定性最高。
      el.addEventListener("dblclick", function(e){
        if(state.pickMode) return;
        var dot = e.target && e.target.closest ? e.target.closest(".mk-dot") : null;
        var uid = dot ? dot.getAttribute("data-uid") : null;
        // 兜底：两次点击之间标记可能被重建（DOM 已替换，e.target 落到容器上），
        // 此时用最近一次点击的标记作为双击对象
        if(!uid && state._lastClickUid && (Date.now() - state._lastClickTs) < 800){
          uid = state._lastClickUid;
        }
        if(!uid) return;
        e.stopPropagation();
        e.preventDefault();
        openDetailFromMap(uid);
      }, true);
    }
    placeMarkers();
  }
  // 取消“待执行的单击设目标”，供双击时调用
  // 注意：_lastClickUid / _lastClickTs 保留，作为“最近点击的标记”供双击兜底使用
  function cancelPendingTargetClick(){
    if(state._clickTimer){ clearTimeout(state._clickTimer); state._clickTimer = null; }
  }
  // 统一入口：从地图标记打开单位详情（双击 / SDK dblclick 两条路径共用，500ms 内去重）
  function openDetailFromMap(uid){
    var now = Date.now();
    if(state._detailOpenTs && now - state._detailOpenTs < 500) return;
    state._detailOpenTs = now;
    cancelPendingTargetClick();     // 双击不切换目标，只弹详情
    openDetail(uid);
  }
  /* ---------------- 地图标记：增量更新（性能护栏，别改回“全量重建”） ----------------
   * 旧实现每次都把全部标记 setMap(null) 再 new 一遍。191 个点位重建一次实测
   * 产生 1457ms 的长任务，而 placeMarkers 会被同步、编码进度、切换视图、拉取
   * 反复调用 → 页面持续卡顿。现在只做三件事：删掉消失的、新建新增的、
   * 其余就地改坐标/内容（不重建 DOM，也不重新绑定事件）。
   * _mkCls 记录每个标记当前写入的 class，避免无谓的 setContent。
   */
  var _mkCls = {};
  function markerCls(rec){
    var cls = "mk-dot";
    if(rec._uid === state.targetUid) cls += " target";
    if(state.searchActive){
      if(state.searchMatches[rec._uid]){
        cls += " hl";
        if(state.searchJustRan) cls += " bounce";
      } else if(rec._uid !== state.targetUid) cls += " dim";
    }
    return cls;
  }
  function markerContent(rec, cls){
    return '<div class="'+cls+'" title="'+esc(rec.name)+'" data-uid="'+rec._uid+'"></div>';
  }
  // 事件只绑定一次；用闭包里的 uid（记录对象可能被云端拉取替换）
  function bindMarker(marker, uid){
    marker.on("click", function(){
      if(state.pickMode){ pickMarkerChosen(uid); return; }
      state._markerClickTs = Date.now();            // 立即记录，供空白地图点击防抖
      var now = Date.now();
      if(state._lastClickUid === uid && (now - state._lastClickTs) < 350){
        state._lastClickUid = uid; state._lastClickTs = now;
        openDetailFromMap(uid);   // 双击同一标记：弹详情，且不改变当前目标
        return;
      }
      state._lastClickUid = uid; state._lastClickTs = now;
      if(state._clickTimer) clearTimeout(state._clickTimer);
      state._clickTimer = setTimeout(function(){
        state._clickTimer = null;
        selectTarget(uid);        // 单击：设为目标（红色+闪烁+面板+距离圆）
      }, 260);
    });
    // 兜底②：高德 SDK 原生 dblclick（部分版本会代理该事件）
    marker.on("dblclick", function(){
      if(state.pickMode) return;
      openDetailFromMap(uid);
    });
  }
  function placeMarkers(){
    if(!state.amap) return;
    var want = {};
    for(var i=0;i<state.data.length;i++){
      var rec = state.data[i];
      if(rec.lng==null || rec.lat==null) continue;
      want[rec._uid] = rec;
    }
    // 1) 删除已消失的点位
    Object.keys(state.markers).forEach(function(k){
      if(want[k]) return;
      try{ state.markers[k].setMap(null); }catch(e){}
      delete state.markers[k]; delete _mkCls[k];
    });
    // 2) 新增 / 就地更新
    Object.keys(want).forEach(function(k){
      var rec = want[k];
      var cls = markerCls(rec);
      var m = state.markers[k];
      if(!m){
        m = new window.AMap.Marker({
          position:[rec.lng, rec.lat],
          anchor:"center",
          title:rec.name,
          zIndex:10,
          content:markerContent(rec, cls),
          extData:{ uid:rec._uid }
        });
        bindMarker(m, rec._uid);
        m.setMap(state.amap);
        state.markers[k] = m; _mkCls[k] = cls;
        return;
      }
      try{
        var pos = m.getPosition();
        if(!pos || pos.lng !== rec.lng || pos.lat !== rec.lat) m.setPosition([rec.lng, rec.lat]);
      }catch(e){}
      try{ if(m.getTitle && m.getTitle() !== rec.name) m.setTitle(rec.name); }catch(e){}
      if(_mkCls[k] !== cls){
        try{ m.setContent(markerContent(rec, cls)); }catch(e){}
        _mkCls[k] = cls;
      }
    });
    state.searchJustRan = false;   // 本次搜索的跳动只播放一次
    updateMapCount();
    renderUnlocated();             // 同步「待编码单位」列表（无坐标的标记不在地图上）
  }
  function updateMapCount(){
    var cnt = Object.keys(state.markers).length;
    var el = $("map-count");
    if(el) el.textContent = state.searchActive ? ("命中 "+Object.keys(state.searchMatches).length+" 个") : ("共 "+cnt+" 个点位");
  }
  // 选中目标单位：地图飞至、标记变红、闪烁 3 秒、右侧面板显示周边
  function selectTarget(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    state.targetUid = uid;
    state.searchActive = false; state.searchMatches = {}; state.searchJustRan = false;
    var box = $("map-suggest"); if(box){ box.style.display = "none"; box.innerHTML = ""; }
    var s = $("map-search"); if(s) s.value = rec.name;
    state.mapQuery = rec.name;
    placeMarkers();                 // 重建标记：目标标红，其余保持原样
    if(rec.lng != null && state.amap){
      try { state.amap.setZoomAndCenter(16, [rec.lng, rec.lat]); }
      catch(e){ state.amap.setCenter([rec.lng, rec.lat]); }
    }
    blinkTarget();
    updateSidePanel();
    if(rec.lng == null) toast("「"+(rec.name||"该单位")+"」尚未编码，地图上暂无点位——可点右侧「📍 手动定位」在地图上点选它的位置", "warn");
  }
  // 目标标记闪烁约 3 秒（动画类自动移除；红色高亮 .target 持续保留）
  function blinkTarget(){
    var uid = state.targetUid; if(!uid) return;
    var el = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
    if(!el) return;
    el.classList.remove("blink");
    void el.offsetWidth;            // 强制重排以重置动画
    el.classList.add("blink");
    setTimeout(function(){ if(el) el.classList.remove("blink"); }, 3000);
  }
  // 周围单位列表单击：地图上对应标记变橙 + 跳动 2 秒，之后自动恢复原样（不改变目标）
  function flashNearbyMarker(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    if(rec.lng == null || rec.lat == null){
      toast("「"+(rec.name||"该单位")+"」暂无坐标，无法在地图上定位", "warn");
      return;
    }
    var el = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
    if(!el){
      toast("该单位未在地图上显示，可先点「🔄 地理编码全部」", "warn");
      return;
    }
    // 若标记不在当前视野内，先把地图移到它身上，保证能看到跳动
    try{
      var b = state.amap && state.amap.getBounds ? state.amap.getBounds() : null;
      if(b && b.contains && !b.contains([rec.lng, rec.lat])) state.amap.setCenter([rec.lng, rec.lat]);
    }catch(e){}
    el.classList.remove("orange","bounce2");
    void el.offsetWidth;                       // 强制重排，重置动画
    el.classList.add("orange","bounce2");
    var item = document.querySelector('.nearby-item[data-uid="'+uid+'"]');
    if(item) item.classList.add("flash");
    if(state._flashTimer) clearTimeout(state._flashTimer);
    state._flashTimer = setTimeout(function(){  // 2 秒后恢复（0.5s × 4）
      var e2 = document.querySelector('.mk-dot[data-uid="'+uid+'"]');
      if(e2) e2.classList.remove("orange","bounce2");
      var it2 = document.querySelector('.nearby-item[data-uid="'+uid+'"]');
      if(it2) it2.classList.remove("flash");
      state._flashTimer = null;
    }, 2000);
  }
  // 周围单位列表双击：把该单位切换为目标单位（同心圆随之移动到它身上）
  function nearbyItemDouble(uid){
    var now = Date.now();
    if(now - state._nbDblTs < 500) return;     // click 路径与 dblclick 路径去重
    state._nbDblTs = now;
    if(state._nbTimer){ clearTimeout(state._nbTimer); state._nbTimer = null; }
    state._nbUid = null; state._nbTs = 0;
    selectTarget(uid);
  }
  // 球面距离（米），用于“周围单位”
  function haversine(lng1, lat1, lng2, lat2){
    var R = 6371000, toR = Math.PI/180;
    var dLat = (lat2-lat1)*toR, dLng = (lng2-lng1)*toR;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*toR)*Math.cos(lat2*toR)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
  }
  // 以目标为中心，只画【当前选定/自定义】的那一个距离圆（不再叠加显示全部半径）
  function drawTargetCircles(activeRadius){
    if(state.targetCircles && state.targetCircles.length){
      state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
    }
    state.targetCircles = [];
    var target = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!target || target.lng == null || target.lat == null || !state.amap) return;
    var rd = parseFloat(activeRadius);
    if(!rd || rd <= 0) rd = 200;                  // 兜底：半径非法时按 200m
    var circle = new window.AMap.Circle({
      center:[target.lng, target.lat],
      radius: rd,
      strokeColor:"#e5484d",
      strokeOpacity:0.8,
      strokeWeight:1.5,          // 描边细一些（原为 3）
      fillColor:"#e5484d",
      fillOpacity:0.08,
      zIndex:6
    });
    circle.setMap(state.amap);
    // 点击距离圈（目标单位以外的区域）→ 取消目标选中，清除距离圆
    circle.on("click", function(e){
      if(e && e.originEvent && e.originEvent.stopPropagation) e.originEvent.stopPropagation();
      clearTarget();
    });
    state.targetCircles.push(circle);
  }
  // 按半径渲染目标周围单位清单（点击半径 tab / 自定义距离触发），并在地图上画出对应半径的圆
  function showNearby(radius){
    state.targetRadius = radius;
    drawTargetCircles(radius);     // 先画/更新距离圆（含清理旧圆；无坐标则清空）
    var tabs = $("radius-tabs");   // 同步快捷选择高亮：自定义半径时无 tab 高亮
    if(tabs) Array.prototype.forEach.call(tabs.children, function(b){
      b.classList.toggle("active", parseInt(b.getAttribute("data-r"), 10) === radius);
    });
    var rl = $("nearby-radius-label"); if(rl) rl.textContent = radius + "m";
    var list = $("nearby-list"); if(!list) return;
    var target = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!target || target.lng == null || target.lat == null){
      list.innerHTML = '<div class="nearby-empty">目标单位暂无坐标，无法计算周边（可先点「🔄 地理编码全部」或「📍 手动选点」）。</div>';
      return;
    }
    var items = [];
    state.data.forEach(function(r){
      if(r._uid === target._uid) return;
      if(r.lng == null || r.lat == null) return;
      var d = haversine(target.lng, target.lat, r.lng, r.lat);
      if(d <= radius) items.push({ rec:r, dist:d });
    });
    items.sort(function(a,b){ return a.dist - b.dist; });
    if(!items.length){
      list.innerHTML = '<div class="nearby-empty">'+radius+'m 范围内没有其他已编码单位。</div>';
      return;
    }
    list.innerHTML = items.map(function(it){
      var r = it.rec;
      return '<div class="nearby-item" data-uid="'+r._uid+'">'+
        '<span class="ni-dist">'+it.dist+'m</span>'+
        '<div class="ni-name">'+esc(r.name)+'</div>'+
        '<div class="ni-sub">'+(r.license ? esc(r.license)+' ｜ ' : '')+esc(r.address||'')+'</div>'+
      '</div>';
    }).join("");
  }
  // 右侧目标卡片 + 显示周边面板
  function updateSidePanel(){
    var card = $("target-card"); if(!card) return;
    var rec = state.data.find(function(r){ return r._uid === state.targetUid; });
    if(!rec){
      card.innerHTML = '<div class="target-empty">在上方搜索框输入关键词，点击候选单位即可将其设为<strong>目标单位</strong>：地图标记变红并闪烁 3 秒，右侧显示其周边单位。<br><br>提示：单击地图上的圆点 = 设为目标；<strong>双击圆点 = 查看单位详情</strong>；点击地图空白处或距离圈 = 取消。</div>';
      var nb0 = $("nearby-block"); if(nb0) nb0.style.display = "none";
      return;
    }
    function row(label, val){
      return '<div class="tc-row"><b>'+label+'：</b>'+(val ? esc(val) : '<span style="color:#9aa1ae">未填写</span>')+'</div>';
    }
    card.innerHTML =
      '<div class="tc-name">'+esc(rec.name)+'</div>'+
      row("许可证号", rec.license)+
      row("经营地址", rec.address)+
      row("设备类型", rec.deviceType)+
      row("联系人", rec.contact)+
      ((rec.validFrom || rec.validTo) ? '<div class="tc-row"><b>有效期：</b>'+esc(rec.validFrom||'')+' 至 '+esc(rec.validTo||'')+'</div>' : '')+
      (rec.remark ? '<div class="tc-row tc-remark"><b>备注：</b>'+esc(rec.remark)+'</div>'
                  : '<div class="tc-row"><b>备注：</b><span style="color:#9aa1ae">未填写</span></div>')+
      (rec.lng != null ? '<div class="tc-row"><b>坐标：</b>'+rec.lng.toFixed(6)+', '+rec.lat.toFixed(6)+'</div>'
                       : '<div class="tc-row"><b>坐标：</b><span style="color:#b45309">未编码（地图上无点位）</span></div>')+
      '<div class="tc-actions">'+
        (rec.lng == null ? '<button id="tc-locate" class="btn sm primary">📍 手动定位</button>' : '')+
        '<button id="tc-edit" class="btn sm'+ (rec.lng == null ? '' : ' primary') +'">✏️ 编辑</button>'+
        '<button id="tc-detail" class="btn sm">单位详情</button>'+
        '<button id="tc-clear" class="btn sm">清除目标</button>'+
      '</div>';
    var editBtn = $("tc-edit");   if(editBtn)   editBtn.addEventListener("click", function(){ openDetail(rec._uid); });
    var detBtn  = $("tc-detail"); if(detBtn)    detBtn.addEventListener("click", function(){ openDetail(rec._uid); });
    var clrBtn  = $("tc-clear");  if(clrBtn)    clrBtn.addEventListener("click", function(){ clearTarget(); });
    var locBtn  = $("tc-locate"); if(locBtn)    locBtn.addEventListener("click", function(){ startManualLocate(rec._uid); });
    var nb = $("nearby-block"); if(nb) nb.style.display = "flex";
    var r = state.targetRadius || 200;
    var cus = $("nearby-custom");
    if(cus) cus.value = ([200,300,500,800].indexOf(r) === -1) ? String(r) : "";
    showNearby(r);
  }
  /* ---------------- 地图手动选点（在主地图操作，不嵌套弹窗） ---------------- */
  function enterPickMode(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    state.pickMode = true;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.add("pick-on");
    showMapHint("手动选点模式：请先在右侧「待编码单位」点「📍 定位」选择要处理的单位（或直接点击地图上的蓝色圆点），再点击地图上的实际位置即可写入坐标（Esc 取消）");
  }
  function exitPickMode(){
    state.pickMode = false;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.remove("pick-on");
    hideMapHint();
  }
  function pickMarkerChosen(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    state.pickTarget = uid;
    showMapHint("已选择「"+rec.name+"」：请在地图上点击它的实际位置以写入坐标（原地址保留，可在详情里修改；Esc 取消）");
  }
  // 从「待编码单位」列表 / 详情弹窗发起手动定位：不依赖地图上是否已有标记
  function startManualLocate(uid){
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec){ toast("未找到该单位", "err"); return; }
    var begin = function(){
      state.pickMode = true;
      state.pickTarget = uid;
      var el = $("amap-container"); if(el) el.classList.add("pick-on");
      showMapHint("已选择「"+(rec.name||"该单位")+"」：请在地图上点击它的实际位置以写入坐标（原地址保留；Esc 取消）");
      toast("请在地图上点击「"+(rec.name||"该单位")+"」的实际位置", "ok");
      // 有地址时先按地址飞到大致的点，方便用户直接微调（不写入数据）
      if(rec.address && state.geocoder){
        geocodeOne(rec).then(function(g){
          if(!g || !state.amap || !state.pickMode || state.pickTarget !== uid) return;
          try{ state.amap.setZoomAndCenter(17, [g.lng, g.lat]); }
          catch(e){ try{ state.amap.setCenter([g.lng, g.lat]); }catch(e2){} }
          showMapHint("已按地址定位到大致位置：「"+(rec.name||"该单位")+"」——请点击它的实际位置写入坐标（原地址保留；Esc 取消）");
        });
      }
    };
    if(state.view !== "map") switchView("map");   // 自动切到地图界面
    if(state.amapReady){ begin(); return; }
    ensureAmap().then(function(ok){
      if(!ok){ toast("高德地图未就绪，请先在「设置界面」配置地图 Key", "warn"); return; }
      initMap();
      begin();
    });
  }
  // 待编码单位列表：无坐标 → 地图上没有标记，故在此集中提供手动定位 / 单条自动编码
  function renderUnlocated(){
    var block = $("unloc-block"), list = $("unloc-list");
    if(!block || !list) return;
    var miss = state.data.filter(function(r){ return r.lng==null || r.lat==null; });
    var cnt = $("unloc-count"); if(cnt) cnt.textContent = miss.length + " 条";
    if(!miss.length){
      block.style.display = "none";
      if(state._unlocSig !== ""){ state._unlocSig = ""; list.innerHTML = ""; updateMapNote(); }
      return;
    }
    var sig = miss.map(function(r){ return r._uid; }).join(",");
    block.style.display = "flex";
    if(sig === state._unlocSig) return;      // 集合未变则不重建，避免列表滚动位置被重置
    state._unlocSig = sig;
    list.innerHTML = miss.slice(0, 300).map(function(r){
      return '<div class="nearby-item unloc-item" data-uid="'+r._uid+'">'+
        '<div class="ni-name">'+esc(r.name || "(未命名单位)")+'</div>'+
        '<div class="ni-sub">'+(r.license ? esc(r.license)+' ｜ ' : '')+esc(r.address || "无地址")+'</div>'+
        '<div class="unloc-actions">'+
          '<button class="btn sm primary" data-locate="'+r._uid+'">📍 定位</button>'+
          (r.address ? '<button class="btn sm" data-geo="'+r._uid+'">自动编码</button>' : '')+
        '</div>'+
      '</div>';
    }).join("") + (miss.length > 300 ? '<div class="nearby-empty">仅显示前 300 条，请用搜索或自动编码处理其余记录。</div>' : '');
    updateMapNote();
  }
  // 地图左下角提示条：随「待编码」数量变化实时更新
  function updateMapNote(){
    if(!state.settings.amapKey || !state.amapReady) return;   // 未配置 / 未就绪时由 renderMapView 统一提示
    var missing = state.data.filter(function(r){ return r.lng==null || r.lat==null; });
    if(missing.length){
      setMapNote('💡 ' + missing.length + ' 条单位尚无坐标',
        '这些单位在地图上没有点位。请在右侧「待编码单位」里点「📍 定位」，然后在地图上点一下它的实际位置即可写入坐标（原地址会保留）；也可以点「自动编码」或上方「🔄 地理编码全部」按地址批量查坐标。');
    } else {
      setMapNote("", null);
    }
  }
  // 单条自动编码（按地址查坐标）
  function geocodeSingle(uid){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    var rec = state.data.find(function(r){ return r._uid === uid; });
    if(!rec) return;
    if(!rec.address){ toast("该单位没有地址，无法自动编码，请用「📍 定位」手动点选", "warn"); return; }
    toast("正在自动编码：「"+(rec.name||"")+"」…", "ok");
    geocodeOne(rec).then(function(g){
      if(g){
        rec.lng = g.lng; rec.lat = g.lat;
        commit({silent:true});
        refreshIfMap();
        toast("已自动编码：「"+(rec.name||"")+"」", "ok");
      } else {
        toast("自动编码失败，请用「📍 定位」手动点选", "warn");
      }
    });
  }
  // 点击空白地图区域 / 距离圈：取消目标选中（清空红色高亮、距离圆与右侧面板）
  function clearTarget(){
    cancelPendingTargetClick();
    state._markerClickTs = 0;
    if(!state.targetUid){
      // 目标已为空，但保险起见再清一次残留圆
      if(state.targetCircles && state.targetCircles.length){
        state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
        state.targetCircles = [];
      }
      return;
    }
    state.targetUid = null;
    if(state.targetCircles && state.targetCircles.length){
      state.targetCircles.forEach(function(c){ try{ c.setMap(null); }catch(e){} });
    }
    state.targetCircles = [];
    placeMarkers();
    updateSidePanel();
  }
  // 周围单位：自定义距离（米）应用
  function applyCustomRadius(){
    var el = $("nearby-custom"); if(!el) return;
    var v = parseFloat(el.value);
    if(!v || v <= 0){ toast("请输入有效的距离（米），如 350", "warn"); el.focus(); return; }
    if(v > 5000){ v = 5000; el.value = "5000"; toast("自定义距离上限 5000m，已按 5000m 计算", "warn"); }
    v = Math.round(v);
    el.value = String(v);
    showNearby(v);
    toast("周围单位范围已设为 "+v+"m", "ok");
  }
  function onMapClick(e){
    if(state.pickMode){
      if(!state.pickTarget){
        toast("请先在右侧「待编码单位」点「📍 定位」选择要处理的单位（或点击地图上的蓝色圆点）", "warn");
        return;
      }
      var lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
      var rec = state.data.find(function(r){ return r._uid === state.pickTarget; });
      exitPickMode();
      if(rec){ reverseGeocode(lng, lat, rec); }
      return;
    }
    // 非选点模式：
    // ① 若事件来自覆盖物（标记 / 距离圆，带 setMap 方法），交给覆盖物自己的处理器，不在此清空
    if(e && e.target && e.target !== state.amap && typeof e.target.setMap === "function") return;
    // ② 刚点过标记（同一次点击冒泡到地图）时忽略，避免“刚选中就被清空”
    if(state._markerClickTs && Date.now() - state._markerClickTs < 300) return;
    // ③ 其余情况（点击目标单位以外的任意区域）→ 取消目标选中并清除距离圆
    clearTarget();
  }
  function showMapHint(msg){
    var h = $("map-hint");
    if(h){ h.textContent = msg; h.style.display = "block"; }
  }
  function hideMapHint(){
    var h = $("map-hint");
    if(h){ h.style.display = "none"; }
  }
  var searchTimer = null;
  function onSearchInput(){
    var q = $("map-search").value.trim();
    if(searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function(){ renderSuggest(q); }, 200);
  }
  // 边输入边弹出候选项
  function renderSuggest(q){
    var box = $("map-suggest");
    if(!box) return;
    q = q.trim().toLowerCase();
    if(!q){ box.style.display = "none"; box.innerHTML = ""; return; }
    var matches = state.data.filter(function(r){
      return (r.name + r.address + r.license).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 12);
    if(!matches.length){ box.style.display = "none"; box.innerHTML = ""; return; }
    box.innerHTML = matches.map(function(r){
      return '<div class="suggest-item" data-uid="'+r._uid+'">'+
        '<div class="si-name">'+esc(r.name)+'</div>'+
        (r.license ? '<div class="si-lic">许可证号：'+esc(r.license)+'</div>' : '')+
        (r.address ? '<div class="si-addr">地址：'+esc(r.address)+'</div>' : '')+
      '</div>';
    }).join("");
    box.style.display = "block";
  }
  function geocodeOne(rec){
    return new Promise(function(resolve){
      if(!state.geocoder || !rec.address){ resolve(null); return; }
      var done = false;
      // 超时保护：若高德回调未触发（限流/网络抖动），避免整批卡死
      var timer = setTimeout(function(){ if(!done){ done = true; resolve(null); } }, 5000);
      state.geocoder.getLocation(rec.address, function(status, result){
        if(done) return;
        done = true; clearTimeout(timer);
        if(status === "complete" && result.geocodes && result.geocodes.length){
          var loc = result.geocodes[0].location;
          resolve({ lng:loc.lng, lat:loc.lat });
        } else {
          resolve(null);
        }
      });
    });
  }
  // 批量地理编码：放慢节奏避免限流，失败重试退避；逐条成功即落盘；可回调进度
  async function geocodeMany(list, onProgress){
    if(!state.amapReady){ return; }
    var stepDelay = 350;   // ~3 QPS，远低于免费密钥限流阈值
    var done = 0, okCount = 0;
    for(var i=0;i<list.length;i++){
      var rec = list[i];
      if(!rec.address) continue;
      if(rec.lng!=null && rec.lat!=null) continue;
      var ok = false;
      for(var attempt=0; attempt<3 && !ok; attempt++){
        var g = await geocodeOne(rec);
        if(g){ rec.lng = g.lng; rec.lat = g.lat; ok = true; }
        else { await sleep(600 * (attempt + 1)); } // 退避重试
      }
      done++; if(ok) okCount++;
      saveDataLocal();                 // 每成功一条立即持久化，绝不丢失已编码结果
      if(onProgress) onProgress(done, list.length, ok);
      await sleep(stepDelay);
    }
    saveDataLocal();
    return okCount;
  }
  var geoRunning = false;
  function geocodeMissing(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    if(geoRunning) return;
    var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
    if(!missing.length){ toast("全部记录已有坐标", "ok"); return; }
    geoRunning = true;
    toast("正在地理编码 " + missing.length + " 条地址…", "ok");
    geocodeMany(missing, function(done, total, ok){
      if(state.view === "map") placeMarkers();   // 边编码边在地图上打点
    }).then(function(okCount){
      geoRunning = false;
      if(state.view === "map") placeMarkers();
      toast("地理编码完成：成功 " + okCount + " / " + missing.length + " 条", "ok");
    });
  }
  function reverseGeocode(lng, lat, rec){
    if(!state.geocoder){ rec.lng=lng; rec.lat=lat; commit({silent:true}); refreshIfMap(); return; }
    var keepAddr = (rec.address || "").trim();   // 原地址（来自台账/Excel）优先保留，避免被反查结果覆盖
    state.geocoder.getAddress([lng, lat], function(status, result){
      var addr = "";
      if(status === "complete" && result.regeocode){
        addr = result.regeocode.formattedAddress;
      }
      if(!keepAddr) rec.address = addr;           // 只有原本没有地址时才用反查地址补全
      rec.lng = lng; rec.lat = lat;
      var dAddr = $("detail-address");
      if(dAddr) dAddr.textContent = rec.address || (lng.toFixed(6)+", "+lat.toFixed(6));
      commit({silent:true});
      refreshIfMap();
      toast("已写入坐标：" + lng.toFixed(6) + ", " + lat.toFixed(6) +
            (keepAddr ? "（原地址已保留）" : (addr ? "（地址已补全为：" + addr + "）" : "")), "ok");
    });
  }

  /* ---------------- Toast ---------------- */
  function toast(msg, type){
    var wrap = $("toast-wrap");
    var t = document.createElement("div");
    t.className = "toast" + (type ? " "+type : "");
    t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add("show"); });
    setTimeout(function(){ t.classList.remove("show"); setTimeout(function(){ t.remove(); }, 300); }, 2600);
  }

  /* ---------------- 弹窗 ---------------- */
  function closeModal(){
    var o = $("modal-overlay");
    if(o) o.remove();
  }
  function showModal(html){
    closeModal();
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "modal-overlay";
    overlay.innerHTML = '<div class="modal">' + html + '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function(e){
      if(e.target === overlay) closeModal();
    });
    return overlay;
  }

  /* ---------------- 单位详情弹窗（全局统一） ---------------- */
  function openDetail(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var du = daysUntil(rec.validTo);
    var duHtml = du==null ? '<span class="pill gray">无日期</span>'
      : (du < 0 ? '<span class="pill red">已逾期 '+Math.abs(du)+' 天</span>'
      : (du <= 30 ? '<span class="pill amber">剩 '+du+' 天</span>' : '<span class="pill green">剩 '+du+' 天</span>'));
    var html =
      '<div class="modal-head"><h3>单位详情</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="kv"><span>编号</span><b>'+esc(rec.id)+'</b></div>' +
        '<div class="kv"><span>单位名称</span><b>'+esc(rec.name)+'</b></div>' +
        '<div class="kv"><span>经营地址</span><b id="detail-address">'+esc(rec.address)+'</b></div>' +
        '<div class="kv"><span>卫生许可证号</span><b>'+esc(rec.license)+'</b></div>' +
        '<div class="kv"><span>有效期始</span><b>'+esc(rec.validFrom)+'</b></div>' +
        '<div class="kv"><span>有效期止</span><b>'+esc(rec.validTo)+' '+duHtml+'</b></div>' +
        '<div class="kv"><span>设备类型</span><b>'+esc(rec.deviceType||"")+'</b></div>' +
        '<div class="kv"><span>联系人</span><b>'+esc(rec.contact||"")+'</b></div>' +
        '<div class="kv"><span>坐标</span><b>'+esc(coordText(rec))+'</b></div>' +
        '<div class="kv"><span>备注</span><b class="remark-text">'+esc(rec.remark||"")+'</b></div>' +
        '<div class="actions">' +
          '<button class="btn" id="detail-locate">📍 在地图上手动定位</button>' +
          '<button class="btn primary" id="detail-edit">编辑</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("detail-edit").onclick = function(){ openEdit(rec._uid); };
    var locBtn = $("detail-locate");
    if(locBtn) locBtn.onclick = function(){ closeModal(); startManualLocate(rec._uid); };
  }

  /* ---------------- 编辑弹窗（可修改全部字段） ---------------- */
  function openEdit(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var html =
      '<div class="modal-head"><h3>编辑单位</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<div class="editgrid">' +
          '<label class="fld">编号<input type="text" id="e-id" value="'+esc(rec.id)+'"></label>' +
          '<label class="fld">单位名称<input type="text" id="e-name" value="'+esc(rec.name)+'"></label>' +
          '<label class="fld">经营地址<input type="text" id="e-address" value="'+esc(rec.address)+'"></label>' +
          '<label class="fld">卫生许可证号<input type="text" id="e-license" value="'+esc(rec.license)+'"></label>' +
          '<label class="fld">有效期始<input type="date" id="e-from" value="'+esc(rec.validFrom)+'"></label>' +
          '<label class="fld">有效期止<input type="date" id="e-to" value="'+esc(rec.validTo)+'"></label>' +
          '<label class="fld">设备类型<input type="text" id="e-device-type" value="'+esc(rec.deviceType||"")+'" placeholder="如 二次供水 / 直饮水"></label>' +
          '<label class="fld">联系人<input type="text" id="e-contact" value="'+esc(rec.contact||"")+'" placeholder="如 张三 13800138000"></label>' +
        '</div>' +
        '<label class="fld" style="margin-top:12px"><span>备注</span>' +
          '<textarea id="e-remark" rows="3" style="width:100%;resize:vertical;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:9px">'+esc(rec.remark||"")+'</textarea>' +
        '</label>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="e-save">保存</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("e-save").onclick = function(){
      var newAddr = $("e-address").value.trim();
      rec.id = $("e-id").value.trim();
      rec.name = $("e-name").value.trim();
      rec.address = newAddr;
      rec.license = $("e-license").value.trim();
      rec.validFrom = $("e-from").value;
      rec.validTo = $("e-to").value;
      rec.remark = $("e-remark").value;
      rec.deviceType = $("e-device-type") ? $("e-device-type").value.trim() : (rec.deviceType||"");
      rec.contact = $("e-contact") ? $("e-contact").value.trim() : (rec.contact||"");
      commit();          // 立即落盘 + 立即与云端对齐
      refreshIfMap();
      renderCurrentView();
      closeModal();
      toast("已保存修改", "ok");
    };
  }

  /* ---------------- 首页：到期提醒 + 办结 ---------------- */
  function renderHome(){
    var win = state.homeWindow;
    var list = state.data.map(function(r){ return { r:r, days:daysUntil(r.validTo) }; })
      .filter(function(x){ return x.days !== null; });
    var overdue = list.filter(function(x){ return x.days < 0; }).sort(function(a,b){ return a.days - b.days; });
    var upcoming = list.filter(function(x){
      if(win === "all") return x.days >= 0;
      return x.days >= 0 && x.days <= Number(win);
    }).sort(function(a,b){ return a.days - b.days; });

    function card(x){
      var r = x.r;
      var pill = x.days < 0 ? '<span class="pill red">已逾期 '+Math.abs(x.days)+' 天</span>'
        : (x.days <= 30 ? '<span class="pill amber">剩 '+x.days+' 天</span>' : '<span class="pill green">剩 '+x.days+' 天</span>');
      return '<div class="reminder" data-action="detail" data-uid="'+r._uid+'">' +
        '<div class="main">' +
          '<div class="nm">'+esc(r.name)+'</div>' +
          '<div class="sub">'+esc(r.address)+' ｜ '+esc(r.license)+' ｜ 有效期止 '+esc(r.validTo)+'</div>' +
        '</div>' +
        '<div class="right">'+pill+
          '<button class="btn primary sm" data-action="banjie" data-uid="'+r._uid+'">办结</button>' +
        '</div>' +
      '</div>';
    }
    var html = "";
    if(overdue.length){
      html += '<div class="grp-title">⚠️ 已过期（'+overdue.length+'）</div>';
      html += overdue.map(card).join("");
    }
    html += '<div class="grp-title">'+(win==="all"?"即将到期":"未来 "+win+" 天内即将到期")+'（'+upcoming.length+'）</div>';
    if(upcoming.length){
      html += upcoming.map(card).join("");
    } else {
      html += '<div class="empty">该时间范围内没有即将到期的单位 🎉</div>';
    }
    $("home-list").innerHTML = html;
  }

  function doBanjie(u){
    var rec = state.data.find(function(r){ return r._uid === u; });
    if(!rec) return;
    var today = iso(new Date());
    var html =
      '<div class="modal-head"><h3>办结 — '+esc(rec.name)+'</h3><button class="x" onclick="window.__wb.closeModal()">×</button></div>' +
      '<div class="modal-body">' +
        '<label class="fld">选择新的「有效期始」日期<input type="date" id="bj-date" value="'+today+'"></label>' +
        '<p class="hint" style="margin-top:12px">系统将自动计算：<b>有效期止 = 所选日期 + 4 年 - 1 天</b></p>' +
        '<div class="kv" style="margin-top:8px"><span>将更新为</span><b id="bj-preview">—</b></div>' +
        '<div class="actions">' +
          '<button class="btn" onclick="window.__wb.closeModal()">取消</button>' +
          '<button class="btn primary" id="bj-save">确认办结</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    function preview(){
      var d = $("bj-date").value;
      $("bj-preview").textContent = d ? (d + "  ~  " + calcValidTo(d)) : "—";
    }
    $("bj-date").addEventListener("change", preview);
    preview();
    $("bj-save").onclick = function(){
      var d = $("bj-date").value;
      if(!d){ toast("请选择日期", "warn"); return; }
      rec.validFrom = d;
      rec.validTo = calcValidTo(d);
      commit();          // 立即落盘 + 立即与云端对齐
      renderCurrentView();
      closeModal();
      toast("已办结：" + rec.name + " 有效期更新至 " + rec.validTo, "ok");
    };
  }

  /* ---------------- 台账 ---------------- */
  function renderLedger(){
    var body = $("ledger-body");
    var q = (state.ledgerQuery||"").trim().toLowerCase();
    var rows = state.data;
    if(q){
      rows = rows.filter(function(r){
        return (r.id+" "+r.name+" "+r.address+" "+(r.deviceType||"")+" "+(r.contact||"")+" "+r.license).toLowerCase().indexOf(q) >= 0;
      });
    }
    if(!rows.length){
      body.innerHTML = '<tr><td colspan="10" class="empty">'+(q?"没有匹配「"+esc(state.ledgerQuery)+"」的单位":"暂无数据，请在上方手动新增或导入。")+'</td></tr>';
    } else {
      body.innerHTML = rows.map(function(r){
        return '<tr data-action="detail" data-uid="'+r._uid+'">' +
          '<td><input type="checkbox" class="rowsel row-select" data-uid="'+r._uid+'" '+(state.selected[r._uid]?"checked":"")+'></td>' +
          '<td class="id-cell">'+esc(r.id)+'</td>' +
          '<td class="name-cell" title="'+esc(r.name)+'">'+esc(r.name)+'</td>' +
          '<td class="addr" title="'+esc(r.address)+'">'+esc(r.address)+'</td>' +
          '<td class="dev-cell" title="'+esc(r.deviceType||"")+'">'+esc(r.deviceType||"")+'</td>' +
          '<td class="dev-cell" title="'+esc(r.contact||"")+'">'+esc(r.contact||"")+'</td>' +
          '<td class="remark-cell" title="'+esc(r.remark||"")+'">'+esc(r.remark||"")+'</td>' +
          '<td class="lic-cell" title="'+esc(r.license)+'">'+esc(r.license)+'</td>' +
          '<td class="date-cell">'+esc(r.validFrom)+'</td>' +
          '<td class="date-cell">'+esc(r.validTo)+'</td>' +
          '<td class="coord-cell">'+esc(coordText(r))+'</td>' +
        '</tr>';
      }).join("");
    }
    updateStat();
    updateLedgerHint();
  }
  function updateLedgerHint(){
    var n = Object.keys(state.selected).filter(function(k){ return state.selected[k]; }).length;
    $("ledger-hint").textContent = n ? ("已选中 "+n+" 条，可批量删除") : "";
  }

  function addManual(){
    var name = $("add-name").value.trim();
    var license = $("add-license").value.trim();
    if(!name){ toast("请填写单位名称", "warn"); return; }
    var exist = state.data.find(function(r){ return r.license === license; });
    if(exist){ toast("该卫生许可证号已存在，请使用导入以覆盖更新", "warn"); return; }
    var rec = {
      _uid: uid(),
      id: $("add-id").value.trim() || nextId(),
      name: name,
      address: $("add-address").value.trim(),
      license: license,
      validFrom: $("add-from").value,
      validTo: $("add-to").value,
      remark: $("add-remark") ? $("add-remark").value.trim() : "",
      deviceType: $("add-device-type") ? $("add-device-type").value.trim() : "",
      contact: $("add-contact") ? $("add-contact").value.trim() : "",
      lng: null, lat: null
    };
    state.data.push(rec);
    saveData(false);
    syncNow({silent:true});   // 立即与云端对齐，不再依赖地理编码结果
    ensureAmap()
      .then(function(){ return geocodeMany([rec]); })
      .catch(function(){ /* 编码失败不影响已新增的数据 */ })
      .then(function(){
        saveData(); renderLedger(); if(state.view==="map") placeMarkers();
      });
    clearAddForm();
    renderLedger();
    toast("已添加单位：" + name, "ok");
  }
  function clearAddForm(){
    ["add-id","add-name","add-address","add-license","add-from","add-to","add-device-type","add-contact"]
      .forEach(function(id){ if($(id)) $(id).value=""; });
    if($("add-remark")) $("add-remark").value="";
  }

  function importExcel(file){
    if(!window.XLSX){ toast("表格解析库未加载，请检查网络后重试", "err"); return; }
    var reader = new FileReader();
    reader.onload = function(e){
      try{
        var wb = window.XLSX.read(e.target.result, { type:"array" });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = window.XLSX.utils.sheet_to_json(ws, { defval:"" });
        var added = 0, updated = 0, toGeocode = [];
        rows.forEach(function(row){
          var lic = String(row["卫生许可证号"]||"").trim();
          if(!lic) return;
          var name = String(row["单位名称"]||row["单位"]||"").trim();
          var address = String(row["经营地址"]||"").trim();
          var vf = normExcelDate(row["有效期始"]);
          var vt = normExcelDate(row["有效期止"]);
          var id = String(row["编号"]||"").trim();
          var remark = String(row["备注"]||"").trim();
          var deviceType = String(row["设备类型"]||row["设备类别"]||"").trim();
          var contact = String(row["联系人"]||"").trim();
          var exist = state.data.find(function(r){ return r.license === lic; });
          if(exist){
            // 存在相同许可证号 → 仅覆盖更新有效期始/止与补充信息
            if(vf) exist.validFrom = vf;
            if(vt) exist.validTo = vt;
            if(remark) exist.remark = remark;
            if(deviceType) exist.deviceType = deviceType;
            if(contact) exist.contact = contact;
            updated++;
            if(exist.address && (exist.lng==null || exist.lat==null)) toGeocode.push(exist);
          } else {
            var rec = {
              _uid: uid(),
              id: id || nextId(),
              name: name,
              address: address,
              license: lic,
              validFrom: vf,
              validTo: vt,
              remark: remark,
              deviceType: deviceType,
              contact: contact,
              lng: null, lat: null
            };
            state.data.push(rec);
            added++;
            if(address) toGeocode.push(rec);
          }
        });
        // 先本地落盘；再【立刻】排一次云端上传。
        // 关键：不能把“保存”押在地理编码这条链上——编码耗时长、失败（高德密钥/域名白名单）、
        // 或编码途中刷新页面，都会导致 .then 里的 saveData() 永远不执行，
        // 新导入的数据就从未推上云端（表现为“导入后没保存，刷新就没了”）。
        saveData(false);
        syncNow({silent:true});   // 导入后立即与云端对齐，不等地理编码
        ensureAmap()
          .then(function(){ return geocodeMany(toGeocode); })
          .catch(function(){ /* 地理编码失败不影响已导入的数据 */ })
          .then(function(){
            // 无论编码成功与否，都要再落盘并同步一次（把坐标写回）
            saveData(); renderLedger(); if(state.view==="map") placeMarkers();
          });
        renderLedger();
        toast("导入完成：新增 "+added+" 条，覆盖更新 "+updated+" 条（已保存并同步）", "ok");
      }catch(err){
        toast("导入失败：" + (err.message||err), "err");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function batchDelete(){
    var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
    if(!keys.length){ toast("请先勾选要删除的记录", "warn"); return; }
    if(!confirm("确定删除选中的 "+keys.length+" 条记录？此操作不可撤销。")) return;
    state.data = state.data.filter(function(r){ return !state.selected[r._uid]; });
    keys.forEach(function(k){ delete state.selected[k]; });
    // 立即与云端对齐：syncNow 会依据 synced 标记把刚删掉的记录从云端删掉，
    // 否则云端残留会在刷新时被自动拉取“复活”
    commit();
    renderLedger();
    if(state.view==="map") placeMarkers();
    toast("已删除 "+keys.length+" 条", "ok");
  }

  function exportJson(){
    var blob = new Blob([JSON.stringify(state.data, null, 2)], { type:"application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "卫生许可台账_导出.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  // 把给定记录导出为 Excel（含设备类型/联系人）
  function exportRowsToXlsx(list){
    var rows = list.map(function(r){
      return {
        "编号": r.id || "",
        "单位名称": r.name || "",
        "经营地址": r.address || "",
        "设备类型": r.deviceType || "",
        "联系人": r.contact || "",
        "卫生许可证号": r.license || "",
        "有效期始": r.validFrom || "",
        "有效期止": r.validTo || "",
        "经度": (r.lng == null ? "" : r.lng),
        "纬度": (r.lat == null ? "" : r.lat),
        "备注": r.remark || ""
      };
    });
    var ws = window.XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [{wch:8},{wch:28},{wch:30},{wch:14},{wch:16},{wch:22},{wch:12},{wch:12},{wch:12},{wch:12},{wch:24}];
    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "单位台账");
    var d = new Date();
    var stamp = d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0");
    window.XLSX.writeFile(wb, "单位台账_" + stamp + ".xlsx");
    toast("已导出 " + rows.length + " 条到 Excel", "ok");
  }
  // 导出“所选”单位：勾了就导勾中的，没勾则询问是否导出全部
  function exportSelected(){
    var keys = Object.keys(state.selected).filter(function(k){ return state.selected[k]; });
    var list;
    if(keys.length){
      list = state.data.filter(function(r){ return state.selected[r._uid]; });
    } else {
      if(!confirm("未勾选任何单位。是否导出全部 " + state.data.length + " 条？")) return;
      list = state.data;
    }
    if(!list.length){ toast("没有可导出的单位", "warn"); return; }
    if(!window.XLSX){ toast("表格组件未加载，请检查网络后重试", "err"); return; }
    exportRowsToXlsx(list);
  }

  /* ---------------- 地图渲染 ---------------- */
  // 地图提示做成悬浮气泡（贴在地图左下角，不抢地图纵向空间），点击展开详情
  function setMapNote(head, full){
    var box = $("map-note-box");
    if(!head){
      box.innerHTML = "";
      return;
    }
    box.innerHTML =
      '<div class="map-note" onclick="this.classList.toggle(\'expanded\')">' +
        '<span class="note-head">' + head + '</span>' +
        (full ? '<div class="note-full">' + full + '</div>' : '') +
        '<span class="note-toggle">▾</span>' +
      '</div>';
  }

  function renderMapView(){
    if(!state.settings.amapKey){
      setMapNote('⚠️ 未配置高德地图 Key',
        '尚未配置高德地图密钥。请前往「设置界面」填写 Key 与安全密钥后，地图与自动地理编码即可生效。');
      return;
    }
    setMapNote("", null);  // 清空，等地图加载回调再决定显示什么
    ensureAmap().then(function(ok){
      if(ok){
        initMap();
        // 回到地图视图时同步右侧面板（目标卡片 / 周围单位 / 距离圈高亮）
        if(state.targetUid) updateSidePanel();
        // 容器尺寸可能随布局变化（如从 block 改为 flex 子项），主动重算地图尺寸，避免空白
        try { if(state.amap && state.amap.resize) state.amap.resize(); } catch(e){}
        // 坐标已持久化（localStorage + CloudBase），打开地图不再重新编码；
        // 未编码的记录地图上没有点位，统一在右侧「待编码单位」里手动定位或自动编码。
        updateMapNote();
      } else {
        setMapNote('⚠️ 地图加载失败', '高德地图加载失败，请检查密钥与网络。');
      }
    });
  }

  function refreshIfMap(){ if(state.view === "map" && state.amap) placeMarkers(); }

  /* ---------------- 设置 ---------------- */
  function fillSettings(){
    $("set-amap-key").value = state.settings.amapKey || "";
    $("set-amap-sec").value = state.settings.amapSecurity || "";
    $("set-cb-env").value = state.settings.cbEnv || "";
    $("set-cb-region").value = state.settings.cbRegion || "ap-shanghai";
    $("set-cb-coll").value = state.settings.cbColl || "water-zyf";
    $("set-cb-proxy").value = state.settings.cbProxy || "";
    var rt = $("set-cb-realtime");
    if(rt) rt.value = (state.settings.realtime === false) ? "0" : "1";
    var cur = $("set-cb-current");
    if(cur){
      var isBuiltin = (state.settings.cbEnv === DEFAULT_SETTINGS.cbEnv);
      cur.textContent = state.settings.cbEnv
        ? ("当前连接：环境 "+state.settings.cbEnv+" / 集合 "+(state.settings.cbColl||"water-zyf")+
           (state.settings.cbProxy ? (" / 代理 "+state.settings.cbProxy) : " / 直连")+
           (isBuiltin ? "（内置）" : "（⚠️ 非内置，与其它设备可能不一致）"))
        : "当前未配置云端";
      cur.className = "sb-current" + (isBuiltin ? "" : " warn");
    }
  }
  function saveSettings(){
    var prevAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    state.settings.amapKey = $("set-amap-key").value.trim();
    state.settings.amapSecurity = $("set-amap-sec").value.trim();
    state.settings.cbEnv = $("set-cb-env").value.trim();
    state.settings.cbRegion = $("set-cb-region").value.trim() || "ap-shanghai";
    state.settings.cbColl = $("set-cb-coll").value.trim() || "water-zyf";
    state.settings.cbProxy = $("set-cb-proxy").value.trim();
    var rtEl = $("set-cb-realtime");
    var rtOn = rtEl ? (rtEl.value !== "0") : true;
    state.settings.realtime = rtOn;
    state.settings.cfgVer = CFG_VER;   // 用户手动保存 = 认可当前配置版本，不再被自动覆盖
    saveSettingsLocal();
    resetCb();                 // 连接参数变化 → 丢弃旧客户端/缓存，按新环境重建
    stopRealtime(); rtState = "off";
    if(rtOn) startRealtime(); else updateRtBadge();
    $("set-status").textContent = "设置已保存。";
    toast("设置已保存", "ok");
    fillSettings();
    var nowAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    if(nowAmap !== prevAmap){
      toast("地图密钥已变更，即将重新加载以生效…");
      setTimeout(function(){ location.reload(); }, 900);
    }
  }
  // 恢复内置云端配置：设备被旧环境锁死时的“一键回到正确环境”
  function restoreBuiltinCloud(){
    if(!confirm("将把 CloudBase 环境/集合/代理恢复为内置配置：\n\n环境 "+DEFAULT_SETTINGS.cbEnv+
                "\n集合 "+DEFAULT_SETTINGS.cbColl+"\n\n本设备当前未同步到云端的本地改动不会丢失。确定继续？")) return;
    CFG_KEYS.forEach(function(k){ state.settings[k] = DEFAULT_SETTINGS[k]; });
    state.settings.cfgVer = CFG_VER;
    saveSettingsLocal();
    resetCb();
    stopRealtime(); rtState = "off";
    fillSettings();
    hideCloudAlert();
    toast("已恢复内置云端配置，正在从云端拉取…", "ok");
    pullCloud({ confirm:false, merge:true, quietError:false });
    startRealtime();
  }

  /* ---------------- 云端连接自检 ----------------
   * 读一次 + 写一条探针（__probe__，随即删除）来区分：可读可写 = 正常；
   * 写入被拒 = 集合安全规则未放开写权限（本项目头号故障）。
   */
  async function checkCloud(){
    var st = $("set-status");
    try{
      var db = await ensureCb();
      if(!db){ if(st) st.textContent = "❌ "+cbUnavailableMsg(); toast(cbUnavailableMsg(), "warn"); return; }
      var coll = db.collection(cbColl());
      if(st) st.textContent = "正在检查云端连接…";
      var c = unwrap(await coll.count(), "统计云端失败");
      var readN = c.total || 0;
      var probe = "__probe__";
      var r = mustAffect(unwrap(await coll.add({ license:probe, id:"0", name:"__probe__" }), "写入探针失败"), "写入探针失败");
      var pid = r.id || null;
      if(pid) unwrap(await coll.doc(pid).remove(), "删除探针失败");
      hideCloudAlert();
      if(st) st.textContent = "✅ 云端连接正常：可读可写" +
        (readN ? ("（读取到 "+readN+" 条样本）") : "（云端当前为空，可点「上传到云端」把本地数据传上去）");
      toast("云端连接正常", "ok");
    }catch(e){
      var m = e.message || String(e);
      if(isPermissionErr(m)) showCloudError(m);
      if(st) st.textContent = "❌ 云端连接失败：" + m;
      toast("云端连接失败："+m, "err");
    }
  }

  /* ---------------- 实时同步自检 ----------------
   * 用「订阅 → 写探针 → 等事件 → 删探针」的方式做真实投递验证。
   */
  async function testRealtime(){
    var st = $("set-status");
    try{
      var db = await ensureCb();
      if(!db){ if(st) st.textContent = "❌ "+cbUnavailableMsg(); toast(cbUnavailableMsg(), "warn"); return; }
      var coll = db.collection(cbColl());
      if(st) st.textContent = "正在检查实时同步（订阅并写入探针，最多 12 秒）…";
      var got = false, watcher = null;
      watcher = coll.watch({
        onChange:function(){ got = true; if(watcher) try{ watcher.close(); }catch(e){} },
        onError:function(e){ /* 走轮询兜底 */ }
      });
      await sleep(1500);
      var probe = "__rt_probe__";
      var w = mustAffect(unwrap(await coll.add({ license:probe, id:"0", name:"__rt_probe__" }), "写入探针失败"), "写入探针失败");
      var waited = 0;
      while(!got && waited < 10000){ await sleep(400); waited += 400; }
      if(w.id){ try{ await coll.doc(w.id).remove(); }catch(e){} }
      if(watcher){ try{ watcher.close(); }catch(e){} }
      if(got){
        rtEventCount++; rtLastEventAt = Date.now(); rtState = "on"; updateRtBadge(); hideCloudAlert();
        if(st) st.textContent = "✅ 实时同步正常：已实测收到云端变更推送";
        toast("实时同步正常", "ok");
      } else {
        rtState = "error"; updateRtBadge();
        showRealtimeAlert("订阅成功但 12 秒内未收到推送（已启用轮询兜底）");
        if(st) st.textContent = "⚠️ 实时推送未收到，已启用每 30 秒轮询兜底；如需真正实时推送，请确认代理支持 WebSocket。";
      }
    }catch(e){
      var m = e.message || String(e);
      if(isPermissionErr(m)) showCloudError(m);
      if(st) st.textContent = "❌ 实时同步检查失败：" + m;
      toast("实时同步检查失败："+m, "err");
    }
  }

  /* ---------------- 视图切换 ---------------- */
  function switchView(v){
    if(v !== "map" && state.pickMode) exitPickMode();   // 离开地图视图时退出选点模式
    state.view = v;
    document.querySelectorAll(".view").forEach(function(s){ s.classList.remove("active"); });
    $("view-"+v).classList.add("active");
    document.querySelectorAll("#tabs button").forEach(function(b){
      b.classList.toggle("active", b.getAttribute("data-view") === v);
    });
    if(v === "home") renderHome();
    else if(v === "ledger") renderLedger();
    else if(v === "map") renderMapView();
    else if(v === "settings") fillSettings();
    updateStat();   // 顶部「共 N 条」：任何视图重绘后都刷新，避免云同步/导入后计数不更新
  }
  function renderCurrentView(){ switchView(state.view); }

  function updateStat(){
    var cnt = $("stat");
    if(cnt) cnt.textContent = "共 " + state.data.length + " 条";
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind(){
    $("tabs").addEventListener("click", function(e){
      var b = e.target.closest("button[data-view]");
      if(b) switchView(b.getAttribute("data-view"));
    });

    // 首页列表（事件委托）
    $("home-list").addEventListener("click", function(e){
      var el = e.target.closest("[data-action]");
      if(!el) return;
      var u = el.getAttribute("data-uid");
      var act = el.getAttribute("data-action");
      if(act === "banjie") doBanjie(u);
      else if(act === "detail") openDetail(u);
    });
    $("home-filter").addEventListener("change", function(){
      state.homeWindow = this.value === "all" ? "all" : Number(this.value);
      renderHome();
    });

    // 台账
    $("ledger-body").addEventListener("click", function(e){
      if(e.target.classList.contains("row-select")) return; // 复选框单独处理
      var el = e.target.closest("[data-action]");
      if(el && el.getAttribute("data-action") === "detail") openDetail(el.getAttribute("data-uid"));
    });
    $("ledger-body").addEventListener("change", function(e){
      if(e.target.classList.contains("row-select")){
        var u = e.target.getAttribute("data-uid");
        state.selected[u] = e.target.checked;
        updateLedgerHint();
      }
    });
    $("select-all").addEventListener("change", function(){
      var checked = this.checked;
      state.data.forEach(function(r){ state.selected[r._uid] = checked; });
      document.querySelectorAll(".row-select").forEach(function(c){ c.checked = checked; });
      updateLedgerHint();
    });
    $("add-submit").addEventListener("click", addManual);
    $("add-clear").addEventListener("click", clearAddForm);
    $("import-btn").addEventListener("click", function(){ $("import-file").click(); });
    $("import-file").addEventListener("change", function(){
      if(this.files && this.files[0]) importExcel(this.files[0]);
      this.value = "";
    });
    $("batch-delete").addEventListener("click", batchDelete);
    $("export-btn").addEventListener("click", exportJson);
    if($("export-sel-btn")) $("export-sel-btn").addEventListener("click", exportSelected);
    // 台账搜索
    $("ledger-search").addEventListener("input", function(){
      state.ledgerQuery = this.value;
      renderLedger();
    });

    // 地图搜索：边输入边出候选项；回车执行高亮跳动
    $("map-search").addEventListener("input", onSearchInput);
    $("map-search").addEventListener("keydown", function(e){
      if(e.key === "Enter"){
        var first = $("map-suggest").querySelector(".suggest-item");
        if(first) selectTarget(first.getAttribute("data-uid"));
        else state.mapQuery = this.value;
      }
    });
    $("map-suggest").addEventListener("click", function(e){
      var it = e.target.closest(".suggest-item"); if(!it) return;
      selectTarget(it.getAttribute("data-uid"));
    });
    // 点击空白处收起候选项
    document.addEventListener("click", function(e){
      var s = $("map-suggest"); if(!s) return;
      if(!e.target.closest(".search-wrap")){ s.style.display = "none"; s.innerHTML = ""; }
    });
    $("geo-all").addEventListener("click", geocodeMissing);
    $("map-pick").addEventListener("click", function(){
      // 若已在选点模式则再次点击退出，否则进入
      if(state.pickMode) exitPickMode();
      else enterPickMode();
    });
    // 周围单位：快捷半径（200/300/500/800m）；点击 item 可把该单位设为新目标
    $("radius-tabs").addEventListener("click", function(e){
      var b = e.target.closest("button"); if(!b) return;
      var cus = $("nearby-custom"); if(cus) cus.value = "";   // 选快捷值时清空自定义输入
      showNearby(parseInt(b.getAttribute("data-r"), 10));
    });
    // 周围单位：自定义距离窗口（应用按钮 / 回车均可触发）
    $("nearby-custom-apply").addEventListener("click", applyCustomRadius);
    $("nearby-custom").addEventListener("keydown", function(e){
      if(e.key === "Enter") applyCustomRadius();
    });
    // 周围单位列表：单击 = 地图上该单位橙色跳动 2 秒；双击 = 切换为目标单位
    $("nearby-list").addEventListener("click", function(e){
      var it = e.target.closest(".nearby-item"); if(!it) return;
      var uid = it.getAttribute("data-uid");
      var now = Date.now();
      if(state._nbUid === uid && (now - state._nbTs) < 350){
        nearbyItemDouble(uid);       // 连点两次 → 切换目标
        return;
      }
      state._nbUid = uid; state._nbTs = now;
      if(state._nbTimer) clearTimeout(state._nbTimer);
      state._nbTimer = setTimeout(function(){
        state._nbTimer = null;
        flashNearbyMarker(uid);      // 单击 → 橙色跳动 2 秒后恢复
      }, 260);
    });
    // 兜底：原生 dblclick（与上面的时间戳检测共用去重，不会重复切换）
    $("nearby-list").addEventListener("dblclick", function(e){
      var it = e.target.closest(".nearby-item"); if(!it) return;
      nearbyItemDouble(it.getAttribute("data-uid"));
    });
    // 待编码单位：📍 定位（手动点选）/ 自动编码（按地址查坐标）
    $("unloc-list").addEventListener("click", function(e){
      var loc = e.target.closest("[data-locate]");
      if(loc){ startManualLocate(loc.getAttribute("data-locate")); return; }
      var geo = e.target.closest("[data-geo]");
      if(geo){ geocodeSingle(geo.getAttribute("data-geo")); return; }
    });

    // 设置
    $("set-save").addEventListener("click", saveSettings);
    if($("sb-check")) $("sb-check").addEventListener("click", checkCloud);
    if($("sb-rt-check")) $("sb-rt-check").addEventListener("click", testRealtime);
    if($("sb-restore")) $("sb-restore").addEventListener("click", restoreBuiltinCloud);
    $("sb-push").addEventListener("click", function(){ pushCloud(false); });
    $("sb-pull").addEventListener("click", function(){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
      pullCloud({ confirm:false });   // 已确认过，避免 pullCloud 内部再次弹确认框
    });

    // 第三方库加载（多 CDN 回退）
    // 背景：原来只从单源加载且没写 onerror，国内网络下常被拦截 → 脚本静默失败 →
    // 自动拉取和实时同步全都不执行，而界面毫无提示。现已改为多 CDN 回退 + 明确告警。
    var autoPulled = false;
    loadScriptWithFallback(CB_SDK_URLS, function(){ return !!window.cloudbase; }, "CloudBase 同步库")
      .then(async function(okUrl){
        if(!okUrl) return;
        if(!autoPulled && state.settings.cbEnv){
          autoPulled = true;
          try{
            await ensureCb();
            pullCloud({ confirm:false, merge:true, quietError:true });
            startRealtime();          // 开启实时通道：其它设备改动后本页自动更新
          }catch(e){ toast("云端初始化失败："+(e.message||e), "err"); }
        }
      });
    loadScriptWithFallback(XLSX_CDNS, function(){ return !!window.XLSX; }, "Excel 解析库")
      .then(function(okUrl){
        if(!okUrl && $("set-status")) { /* 导入 Excel 时会再提示一次 */ }
      });
  }
  // 依次尝试多个 CDN，返回首个加载成功的 URL；全部失败返回 null 并给出明确告警
  function loadScriptWithFallback(urls, check, label){
    return new Promise(function(resolve){
      var i = 0;
      function tryNext(){
        if(i >= urls.length){
          showCloudAlert("warn",
            '<b>⚠️ ' + label + '加载失败</b><br>' +
            '已尝试 ' + urls.length + ' 个 CDN 源都没能加载成功，通常是当前网络拦截了这些域名。' +
            '这会导致<b>云端同步与实时更新完全不可用</b>（数据仍然安全保存在本机）。<br>' +
            '建议：① 换一个网络（如手机热点）后按 <b>Ctrl+Shift+R</b> 重试；' +
            '② 或检查是否有代理/拦截插件屏蔽了 jsdelivr、unpkg 等域名。');
          resolve(null);
          return;
        }
        var url = urls[i++];
        var s = document.createElement("script");
        var settled = false;
        s.src = url;
        s.async = true;
        s.onload = function(){
          if(settled) return; settled = true;
          if(check()) resolve(url); else tryNext();   // 加载了但没定义全局 → 继续换源
        };
        s.onerror = function(){
          if(settled) return; settled = true;
          tryNext();
        };
        // 超时保护：某些网络会一直挂着不触发 onload/onerror
        setTimeout(function(){ if(!settled){ settled = true; tryNext(); } }, 12000);
        document.head.appendChild(s);
      }
      tryNext();
    });
  }

  /* ---------------- 启动 ---------------- */
  // 调试/自检钩子（无头回归测试也依赖这些入口）
  window.__wb = {
    closeModal: closeModal, openDetail: openDetail, enterPickMode: enterPickMode, exitPickMode: exitPickMode,
    state: state, ensureCb: ensureCb, syncNow: syncNow, pullCloud: pullCloud, pushCloud: pushCloud,
    checkCloud: checkCloud, testRealtime: testRealtime, restoreBuiltinCloud: restoreBuiltinCloud,
    switchView: switchView, DEFAULT_SETTINGS: DEFAULT_SETTINGS, CFG_VER: CFG_VER
  };

  // Esc：取消地图手动选点 / 取消目标选中（清除距离圆与右侧面板）
  document.addEventListener("keydown", function(e){
    if(e.key !== "Escape") return;
    if(state.pickMode){ exitPickMode(); return; }
    if($("modal-overlay")) return;          // 弹窗打开时交给弹窗处理
    if(state.targetUid) clearTarget();
  });
  function init(){
    loadSettings();
    installCbProxy();     // 同域代理：把 CloudBase 网关请求改写到 /cbapi（免安全域名白名单）
    loadData();
    bind();
    updateStat();
    switchView("home");
    updateRtBadge();   // 初始化即如实显示实时同步状态（含“尚未验证”的 title 说明）
    if(state._cfgUpgraded) showCfgUpgradeNotice();
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
