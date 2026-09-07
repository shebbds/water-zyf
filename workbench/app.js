/* 卫生许可个人业务工作台 — 应用逻辑
 * 数据源：window.SEED_DATA（来自《zyf test.xlsx》）
 * 所有页面共享同一套本地数据（localStorage），并可选同步到 Supabase。
 */
(function(){
  "use strict";

  var LS_DATA = "hp_workbench_data_v2";
  var LS_SYNCED = "hp_workbench_synced_v2";
  var LS_SETTINGS = "hp_workbench_settings";
  // 内置默认配置（开箱即用；如需清除请在「设置界面」留空并保存）
  var DEFAULT_SETTINGS = {
    amapKey:"78b6849a32ebdb6c5db2371b3eb3a732",
    amapSecurity:"c930ea76af4fe01a9ab82e82ca85b3b2",
    supabaseUrl:"https://tchrevgamfaxjmjcqeww.supabase.co",
    supabaseKey:"sb_publishable_WDg9H-OEl5ickKrRqQpcfQ_qVFk_oM1",
    supabaseTable:"units",
    realtime:true            // 多设备实时同步（Supabase Realtime）
  };

  var state = {
    data: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    view: "home",
    homeWindow: 30,
    selected: {},          // uid -> true
    synced: {},           // license -> true：已知存在于云端的许可证号（用于区分“本地新增”与“别处已删除”）
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
    ledgerQuery: ""         // 台账搜索词
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
    try{
      var raw = localStorage.getItem(LS_SETTINGS);
      if(raw){
        var parsed = JSON.parse(raw);
        Object.keys(parsed).forEach(function(k){
          if(parsed[k] !== undefined && parsed[k] !== "") state.settings[k] = parsed[k];
        });
      } else {
        // 首次运行：把内置默认（含密钥）固化到本地，真正“配置进去”
        saveSettingsLocal();
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

  /* ---------------- 云同步（Supabase） ---------------- */
  var sbClient = null;
  function getSb(){
    if(!state.settings.supabaseUrl || !state.settings.supabaseKey) return null;
    if(!sbClient && window.supabase){
      sbClient = window.supabase.createClient(state.settings.supabaseUrl, state.settings.supabaseKey);
    }
    return sbClient;
  }
  function toRows(){
    return state.data.map(function(r){
      return {
        license:r.license, id:r.id, name:r.name, address:r.address,
        valid_from:r.validFrom, valid_to:r.validTo, lng:r.lng, lat:r.lat,
        remark:r.remark||"", device_type:r.deviceType||"", contact:r.contact||""
      };
    });
  }
  // 解析“云端不存在某列”的报错（PostgREST 42703），返回列名，如 remark / device_type / contact
  function missingColumn(err){
    if(!err) return null;
    var m = String(err.message||"") + " " + String(err.hint||"");
    var m1 = m.match(/column "([^"]+)" of relation/);        // column "remark" of relation "units" does not exist
    if(m1) return m1[1];
    var m2 = m.match(/Could not find the '([^']+)' column/); // Could not find the 'remark' column of 'units'...
    if(m2) return m2[1];
    return null;
  }
  // 上传行数据：云端缺少某些列时自动剔除该列并重试，保证其余字段仍能同步。
  // 返回 { res, dropped }，dropped 为被剔除的列名（说明这些字段暂未同步到云端）。
  async function upsertRows(rows){
    var c = getSb();
    var dropped = [], res = null;
    for(var i=0; i<6; i++){
      var payload = rows.map(function(r){
        var x = Object.assign({}, r);
        dropped.forEach(function(k){ delete x[k]; });
        return x;
      });
      res = await c.from(state.settings.supabaseTable).upsert(payload, { onConflict:"license" });
      if(!res.error) break;
      var miss = missingColumn(res.error);
      if(!miss || dropped.indexOf(miss) >= 0) break;
      dropped.push(miss);
    }
    return { res: res, dropped: dropped };
  }
  // 静默自动同步（防抖触发）失败时也要让用户看见，否则“保存失败”会被完全吞掉，
  // 表现为“导入了、看着有，刷新就没了”却没有任何提示。同一条错误 60 秒内只提示一次。
  var _syncErrAt = {};
  function warnSyncError(msg){
    var key = String(msg).slice(0, 80);
    var now = Date.now();
    if(_syncErrAt[key] && now - _syncErrAt[key] < 60000) return;
    _syncErrAt[key] = now;
    var extra = /row-level security|42501/i.test(msg)
      ? " —— 请在 Supabase 执行：alter table units disable row level security;"
      : "";
    toast("云端保存失败（数据仅存本地）：" + msg + extra, "err");
  }
  async function pushCloud(silent){
    var c = getSb();
    if(!c){ if(!silent) toast("请先在设置中配置 Supabase", "warn"); return; }
    try{
      var rows = toRows();
      var out = await upsertRows(rows);
      if(out.res.error) throw out.res.error;
      markAllSynced();
      if(!silent){
        toast("已上传 "+rows.length+" 条到云端" +
              (out.dropped.length ? "（云端缺少列 "+out.dropped.join("、")+"，这些字段未同步）" : ""),
              out.dropped.length ? "warn" : "ok");
      }
    }catch(e){
      var m = e.message || String(e);
      if(!silent) toast("上传失败：" + m, "err");
      else warnSyncError(m);
    }
  }
  // 云端删除：从 Supabase units 表真正删除，使该记录在云端消失；
  // 配合 pullCloud 的 synced 标记策略：许可证号仍留在 state.synced 中，
  // 其它设备拉取时发现“该 license 曾在云端、现云端已无”即把本地副本删除（删除跨设备传播）
  async function deleteCloud(licenses, silent){
    var c = getSb();
    if(!c || !licenses || !licenses.length) return;
    try{
      var res = await c.from(state.settings.supabaseTable).delete().in("license", licenses);
      if(res.error) throw res.error;
      if(!silent) toast("已从云端删除 "+licenses.length+" 条", "ok");
    }catch(e){
      if(!silent) toast("云端删除失败：" + (e.message||e), "err");
    }
  }
  var syncTimer = null;
  function scheduleSync(){
    if(syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(function(){ pushCloud(true); }, 1500);
  }

  /* ---------------- 即时全量对齐（台账操作后调用） ----------------
   * 与 scheduleSync（1.5s 防抖、只 upsert）不同：syncNow 立即执行，
   * 且让【云端与本地完全一致】——新增/编辑=upsert，本地已删=从云端删除。
   * 删除判定直接看「云端有但本地没有」：用户主动删除是明确的意图，必须立即
   * 反映到云端；多设备间的数据合并由 loadData + pullCloud（自动拉取）保证，
   * 不会因为本函数被误删。
   */
  var _aligning = false, _alignPending = false;
  async function syncNow(opts){
    opts = opts || {};
    if(_aligning){ _alignPending = true; return; }   // 已有同步在跑 → 结束后补跑一次
    var c = getSb();
    if(!c){ if(!opts.silent) toast("请先在设置中配置 Supabase", "warn"); return; }
    _aligning = true;
    try{
      var table = state.settings.supabaseTable;
      // 1) 上传本地全部记录（覆盖新增与编辑）；云端缺列时自动剔除该列重试
      var rows = toRows();
      var out = await upsertRows(rows);
      if(out.res.error) throw out.res.error;
      markAllSynced();

      // 2) 删除云端残留：本设备曾同步过(synced)、但本地现已没有的记录
      var localLic = {};
      state.data.forEach(function(r){ if(r.license) localLic[r.license] = true; });
      var rd = await c.from(table).select("license");
      if(rd.error) throw rd.error;
      var stale = (rd.data || []).map(function(d){ return d.license; })
                    .filter(function(l){ return l && !localLic[l]; });
      if(stale.length){
        var dd = await c.from(table).delete().in("license", stale);
        if(dd.error) throw dd.error;
      }
      if(!opts.silent){
        var extra = [];
        if(stale.length) extra.push("同步删除 " + stale.length + " 条");
        if(out.dropped.length) extra.push("云端缺列 " + out.dropped.join("、"));
        toast("已与云端对齐：" + state.data.length + " 条" +
              (extra.length ? "（" + extra.join("；") + "）" : ""),
              out.dropped.length ? "warn" : "ok");
      }
    }catch(e){
      var m = e.message || String(e);
      if(!opts.silent) toast("云端对齐失败：" + m, "err");
      else warnSyncError(m);
    }finally{
      _aligning = false;
      if(_alignPending){ _alignPending = false; syncNow(opts); }
    }
  }
  // 台账操作后的统一提交：立即落盘 + 立即与云端对齐
  function commit(opts){ saveDataLocal(); syncNow(opts); }

  /* ---------------- 多设备实时同步（Supabase Realtime） ----------------
   * 订阅 units 表的 INSERT/UPDATE/DELETE，任何设备改动后本页立即自动合并，
   * 无需手动刷新。合并沿用 pullCloud(merge) 的规则，不会覆盖本地未同步的新增。
   * 依赖：Supabase 后台需执行一次
   *   alter publication supabase_realtime add table units;
   */
  var rtChannel = null, rtTimer = null, rtState = "off";   // off|connecting|on|error
  function updateRtBadge(){
    var el = $("rt-badge");
    if(!el) return;
    var txt = rtState === "on" ? "实时同步：已连接"
            : rtState === "connecting" ? "实时同步：连接中…"
            : rtState === "error" ? "实时同步：未连接"
            : "实时同步：未启用";
    if(state.settings.realtime === false && rtState === "off") txt = "实时同步：已关闭";
    el.textContent = txt;
    el.className = "rt-badge " + rtState;
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
  function startRealtime(){
    var c = getSb();
    if(!c) return;
    if(state.settings.realtime === false){ stopRealtime(); rtState = "off"; updateRtBadge(); return; }
    if(rtChannel) return;
    rtState = "connecting"; updateRtBadge();
    try{
      rtChannel = c.channel("units-rt-" + Math.random().toString(36).slice(2,8))
        .on("postgres_changes",
            { event:"*", schema:"public", table: state.settings.supabaseTable },
            function(){ scheduleRealtimePull(); })
        .subscribe(function(status){
          if(status === "SUBSCRIBED"){ rtState = "on"; }
          else if(status === "CHANNEL_ERROR" || status === "TIMED_OUT"){ rtState = "error"; }
          else if(status === "CLOSED"){ rtState = "off"; }
          updateRtBadge();
        });
    }catch(e){
      rtState = "error"; updateRtBadge();
    }
  }
  function stopRealtime(){
    if(rtTimer){ clearTimeout(rtTimer); rtTimer = null; }
    try{ if(rtChannel){ var c = getSb(); if(c) c.removeChannel(rtChannel); } }catch(e){}
    rtChannel = null;
  }
  // 从云端拉取。opts: { confirm:是否先确认覆盖, merge:按许可证号合并(保留本地独有记录、坐标不空覆盖),
  //                  quietError:静默错误提示, silent:静默全部提示 }
  async function pullCloud(opts){
    opts = opts || {};
    var c = getSb();
    if(!c){ if(!opts.silent) toast("请先在设置中配置 Supabase", "warn"); return; }
    if(opts.confirm !== false && opts.merge !== true){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
    }
    try{
      var res = await c.from(state.settings.supabaseTable).select("*");
      if(res.error) throw res.error;
      var rows = res.data || [];
      if(opts.merge === true){
        // 合并模式：以 synced 标记为据，区分“本地新增”与“别处已删除”
        var cloudLicenses = {};
        rows.forEach(function(d){ cloudLicenses[d.license] = true; });
        // 仅删除“曾在云端(state.synced)、但云端现已没有”的本地记录 = 其它设备的删除已传播；
        // 从未推上云端的本地新增（不在 synced）不会被误删，刷新后保留。
        // 剪枝的安全条件：①云端有记录，或②本设备此前已确认过云端记录(synced 非空)。
        // 两者都不满足时（RLS 屏蔽读取导致读到空、或首次运行）【绝不剪枝】，
        // 否则会把本地已有数据全部误删（刷新即空）。
        // 必须允许“云端被删空”的情况剪枝，否则其它设备删掉最后一条时本端不会跟着删。
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
            // 仅当云端确实有该列（值非 undefined）时才覆盖本地，
            // 否则云端缺列会把本地已有的备注/设备类型/联系人清空
            if(d.remark != null) base.remark = d.remark;
            if(d.device_type != null) base.deviceType = d.device_type;
            if(d.contact != null) base.contact = d.contact;
            if(d.lng != null) base.lng = d.lng;
            if(d.lat != null) base.lat = d.lat;
          } else {
            state.data.push({ _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
              validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat,
              remark:(d.remark||""), deviceType:(d.device_type||""), contact:(d.contact||"") });
          }
          if(d.license) state.synced[d.license] = true;
        });
        saveSynced();
      } else {
        state.data = rows.map(function(d){
          return { _uid: uid(), id:d.id, name:d.name, address:d.address, license:d.license,
            validFrom:d.valid_from, validTo:d.valid_to, lng:d.lng, lat:d.lat,
            remark:(d.remark||""), deviceType:(d.device_type||""), contact:(d.contact||"") };
        });
        // 全量覆盖分支：云端即为真相，每条云端记录都标记为已同步
        state.synced = {};
        rows.forEach(function(d){ if(d.license) state.synced[d.license] = true; });
        saveSynced();
      }
      saveDataLocal();
      renderCurrentView();
      if(rows.length) toast("已从云端同步 "+rows.length+" 条"+(opts.merge?"（已与本地合并）":""), "ok");
    }catch(e){
      if(!opts.quietError && !opts.silent) toast("拉取失败：" + (e.message||e), "err");
    }
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
  async function ensureAmap(){
    if(state.amapReady) return true;
    if(!state.settings.amapKey){
      return false;
    }
    try{
      await loadAmapScript(state.settings.amapKey, state.settings.amapSecurity);
      state.geocoder = new window.AMap.Geocoder({ city:"北京", citylimit:false });
      state.amapReady = true;
      return true;
    }catch(e){
      toast("高德地图加载失败：" + e.message, "err");
      return false;
    }
  }
  function initMap(){
    var el = $("amap-container");
    if(!state.amap){
      state.amap = new window.AMap.Map(el, { zoom:12, center:[116.41,39.95] });
      state.amap.addControl(new window.AMap.ToolBar());
      state.amap.addControl(new window.AMap.Scale());
      state.amap.on("click", onMapClick);   // 仅在地图创建时绑定一次，避免重复监听
    }
    placeMarkers();
  }
  function placeMarkers(){
    if(!state.amap) return;
    Object.keys(state.markers).forEach(function(k){ state.markers[k].setMap(null); });
    state.markers = {};
    state.data.forEach(function(rec){
      if(rec.lng==null || rec.lat==null) return;
      // 圆形标记；搜索高亮/跳动直接写入内容 class，保证稳定生效
      var cls = "mk-dot";
      if(state.searchActive){
        if(state.searchMatches[rec._uid]){
          cls += " hl";
          if(state.searchJustRan) cls += " bounce";
        } else cls += " dim";
      }
      var marker = new window.AMap.Marker({
        position:[rec.lng, rec.lat],
        anchor:"center",
        title:rec.name,
        zIndex:10,
        content:'<div class="'+cls+'" title="'+esc(rec.name)+'" data-uid="'+rec._uid+'"></div>',
        extData:{ uid:rec._uid }
      });
      marker.on("click", function(){
        if(state.pickMode) pickMarkerChosen(rec._uid);
        else openDetail(rec._uid);
      });
      marker.setMap(state.amap);
      state.markers[rec._uid] = marker;
    });
    state.searchJustRan = false;   // 本次搜索的跳动只播放一次
    updateMapCount();
  }
  function updateMapCount(){
    var cnt = Object.keys(state.markers).length;
    var el = $("map-count");
    if(el) el.textContent = state.searchActive ? ("命中 "+Object.keys(state.searchMatches).length+" 个") : ("共 "+cnt+" 个点位");
  }
  // 搜索：高亮匹配项（跳动）+ 其余淡化，并缩放地图以显示全部结果
  function performSearch(q){
    var box = $("map-suggest");
    if(box){ box.style.display = "none"; box.innerHTML = ""; }
    q = (q||"").trim().toLowerCase();
    if(!q){
      state.searchActive = false; state.searchMatches = {}; state.searchJustRan = false;
      placeMarkers();
      var c = $("map-count"); if(c) c.textContent = "共 "+Object.keys(state.markers).length+" 个点位";
      return;
    }
    var matched = {};
    state.data.forEach(function(rec){
      var hit = (rec.name + rec.address + rec.license).toLowerCase().indexOf(q) >= 0;
      if(hit){ matched[rec._uid] = true; }
    });
    state.searchActive = true;
    state.searchMatches = matched;
    state.searchJustRan = true;     // 触发一次跳动
    placeMarkers();                 // 重建标记，高亮/跳动直接写入内容
    // 从“重建后”的 markers 中收集命中项（旧引用已离图，必须用新引用）
    var matchedMarkers = Object.keys(state.searchMatches)
      .map(function(u){ return state.markers[u]; })
      .filter(Boolean);
    if(matchedMarkers.length){
      state.amap.setFitView(matchedMarkers, false, [80,80,80,80]);
    }
    var c = $("map-count");
    if(c) c.textContent = "命中并高亮 "+matchedMarkers.length+" 个（跳动中）";
  }
  /* ---------------- 地图手动选点（在主地图操作，不嵌套弹窗） ---------------- */
  function enterPickMode(){
    if(!state.amapReady){ toast("请先配置高德地图密钥", "warn"); return; }
    state.pickMode = true;
    state.pickTarget = null;
    var el = $("amap-container"); if(el) el.classList.add("pick-on");
    showMapHint("手动选点模式：请先在地图上点击要更新的「单位标记」（蓝色圆点），选中后再点击地图任意位置设置新地址（按 Esc 取消）");
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
    showMapHint("已选择「"+rec.name+"」：请在地图上点击任意位置以更新其地址与坐标（Esc 取消）");
  }
  function onMapClick(e){
    if(!state.pickMode) return;
    if(!state.pickTarget) return;   // 需先点选单位标记
    var lng = e.lnglat.getLng(), lat = e.lnglat.getLat();
    var rec = state.data.find(function(r){ return r._uid === state.pickTarget; });
    exitPickMode();
    if(rec){ reverseGeocode(lng, lat, rec); }
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
    }).slice(0, 10);
    if(!matches.length){ box.style.display = "none"; box.innerHTML = ""; return; }
    box.innerHTML = matches.map(function(r){
      return '<div class="suggest-item" data-uid="'+r._uid+'">'+
        '<div class="si-name">'+esc(r.name)+'</div>'+
        '<div class="si-sub">'+esc(r.license)+' ｜ '+esc(r.address)+'</div>'+
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
    state.geocoder.getAddress([lng, lat], function(status, result){
      var addr = "";
      if(status === "complete" && result.regeocode){
        addr = result.regeocode.formattedAddress;
      }
      rec.address = addr;
      rec.lng = lng; rec.lat = lat;
      var dAddr = $("detail-address");
      if(dAddr) dAddr.textContent = addr || (lng.toFixed(6)+", "+lat.toFixed(6));
      commit({silent:true});
      refreshIfMap();
      toast("已更新地址与坐标：" + (addr || (lng.toFixed(6)+", "+lat.toFixed(6))), "ok");
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
          '<button class="btn primary" id="detail-edit">编辑</button>' +
        '</div>' +
      '</div>';
    showModal(html);
    $("detail-edit").onclick = function(){ openEdit(rec._uid); };
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
          '<td>'+esc(r.id)+'</td>' +
          '<td>'+esc(r.name)+'</td>' +
          '<td class="addr">'+esc(r.address)+'</td>' +
          '<td class="dev-cell" title="'+esc(r.deviceType||"")+'">'+esc(r.deviceType||"")+'</td>' +
          '<td class="dev-cell" title="'+esc(r.contact||"")+'">'+esc(r.contact||"")+'</td>' +
          '<td class="remark-cell" title="'+esc(r.remark||"")+'">'+esc(r.remark||"")+'</td>' +
          '<td>'+esc(r.license)+'</td>' +
          '<td>'+esc(r.validFrom)+'</td>' +
          '<td>'+esc(r.validTo)+'</td>' +
          '<td>'+esc(coordText(r))+'</td>' +
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
  function renderMapView(){
    var box = $("map-note-box");
    if(!state.settings.amapKey){
      box.innerHTML = '<div class="map-note" style="margin-bottom:12px">尚未配置高德地图密钥。请前往「设置界面」填写 Key 与安全密钥后，地图与自动地理编码即可生效。</div>';
      return;
    }
    box.innerHTML = "";
    ensureAmap().then(function(ok){
      if(ok){
        initMap();
        // 坐标已持久化（localStorage + Supabase），打开地图不再重新编码；
        // 仅提示尚未编码的地址，由用户点「地理编码全部」或手动选点来完成。
        var missing = state.data.filter(function(r){ return (r.lng==null || r.lat==null) && r.address; });
        if(missing.length){
          box.innerHTML = '<div class="map-note" style="margin-bottom:12px">已编码的坐标已记住、不会重复编码。当前还有 '+missing.length+' 条地址未编码，点上方「🔄 地理编码全部」即可生成地图点位（手动地图上选点也会自动记录坐标）。</div>';
        } else {
          box.innerHTML = "";
        }
      } else {
        box.innerHTML = '<div class="map-note" style="margin-bottom:12px">高德地图加载失败，请检查密钥与网络。</div>';
      }
    });
  }

  function refreshIfMap(){ if(state.view === "map" && state.amap) placeMarkers(); }

  /* ---------------- 设置 ---------------- */
  function fillSettings(){
    $("set-amap-key").value = state.settings.amapKey || "";
    $("set-amap-sec").value = state.settings.amapSecurity || "";
    $("set-sb-url").value = state.settings.supabaseUrl || "";
    $("set-sb-key").value = state.settings.supabaseKey || "";
    $("set-sb-table").value = state.settings.supabaseTable || "units";
    var rt = $("set-sb-realtime");
    if(rt) rt.value = (state.settings.realtime === false) ? "0" : "1";
  }
  function saveSettings(){
    var prevAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    state.settings.amapKey = $("set-amap-key").value.trim();
    state.settings.amapSecurity = $("set-amap-sec").value.trim();
    state.settings.supabaseUrl = $("set-sb-url").value.trim();
    state.settings.supabaseKey = $("set-sb-key").value.trim();
    state.settings.supabaseTable = $("set-sb-table").value.trim() || "units";
    var rtEl = $("set-sb-realtime");
    var rtOn = rtEl ? (rtEl.value !== "0") : true;
    state.settings.realtime = rtOn;
    saveSettingsLocal();
    // 实时开关/连接参数变化 → 重建订阅
    stopRealtime(); rtState = "off";
    if(rtOn) startRealtime(); else updateRtBadge();
    var nowAmap = state.settings.amapKey + "|" + state.settings.amapSecurity;
    $("set-status").textContent = "设置已保存。";
    toast("设置已保存", "ok");
    if(nowAmap !== prevAmap){
      toast("地图密钥已变更，即将重新加载以生效…");
      setTimeout(function(){ location.reload(); }, 900);
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
      if(e.key === "Enter"){ state.mapQuery = this.value; performSearch(this.value); }
    });
    $("map-suggest").addEventListener("click", function(e){
      var it = e.target.closest(".suggest-item"); if(!it) return;
      var u = it.getAttribute("data-uid");
      var rec = state.data.find(function(r){ return r._uid === u; });
      if(!rec) return;
      $("map-search").value = rec.name;
      state.mapQuery = rec.name;
      performSearch(rec.name);
      if(rec.lng != null && state.amap) state.amap.setCenter([rec.lng, rec.lat]);
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

    // 设置
    $("set-save").addEventListener("click", saveSettings);
    $("sb-push").addEventListener("click", function(){ pushCloud(false); });
    $("sb-pull").addEventListener("click", function(){
      if(!confirm("从云端拉取将用云端数据覆盖本地全部记录，确定继续？")) return;
      pullCloud();
    });

    // Supabase 库加载（CDN）
    var autoPulled = false;
    var sb = document.createElement("script");
    sb.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    sb.onload = function(){
      // Supabase 就绪后，自动从云端合并一次：打开页面即与云端同步，无需手动拉取
      if(!autoPulled && state.settings.supabaseUrl && state.settings.supabaseKey){
        autoPulled = true;
        pullCloud({ confirm:false, merge:true, quietError:true });
        startRealtime();          // 开启实时通道：其它设备改动后本页自动更新
      }
    };
    document.head.appendChild(sb);
    // SheetJS 库加载（CDN）
    var xls = document.createElement("script");
    xls.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    document.head.appendChild(xls);
  }

  /* ---------------- 启动 ---------------- */
  window.__wb = { closeModal: closeModal, openDetail: openDetail, enterPickMode: enterPickMode, exitPickMode: exitPickMode };

  // Esc 取消地图手动选点
  document.addEventListener("keydown", function(e){
    if(e.key === "Escape" && state.pickMode) exitPickMode();
  });
  function init(){
    loadSettings();
    loadData();
    bind();
    updateStat();
    switchView("home");
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
