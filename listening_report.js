const LOCAL_UTC_OFFSET_HOURS = -4; // Eastern (adjust if needed)

let SCROBBLES = null;
let ARTIST_COUNTRY = null; // null until artist_countries.json loads successfully

async function boot(){
  // 1. Load the raw, unmodified Last.fm export -- required
  let raw;
  try {
    const res = await fetch('./lastfm_data.json', {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    raw = await res.json();
    if(!raw.scrobbles || !Array.isArray(raw.scrobbles)) throw new Error('unexpected shape: missing scrobbles[]');
  } catch(err){
    console.error('Failed to load lastfm_data.json', err);
    document.getElementById('loadError').style.display = 'block';
    return;
  }
  SCROBBLES = raw.scrobbles;
  document.getElementById('mainWrap').style.display = 'block';
  document.getElementById('heroUser').textContent = raw.username || '';

  // 2. Try to load the artist -> country lookup -- optional, may not exist yet
  try {
    const res2 = await fetch('./artist_countries.json', {cache:'no-store'});
    if(res2.ok){
      ARTIST_COUNTRY = await res2.json();
    }
  } catch(err){
    // fine -- country-based stats just stay hidden
    console.log('artist_countries.json not found yet; Canadian stats hidden.', err);
  }

  render();
}

// ---------- helpers ----------
function normArtist(s){
  return String(s).toLowerCase()
    .replace(/&/g,'and')
    .replace(/[^a-z0-9 ]/g,'')
    .replace(/\s+/g,' ')
    .trim()
    .replace(/^the /,'');
}

function localDate(ms){
  return new Date(ms + LOCAL_UTC_OFFSET_HOURS*3600*1000);
}
function ymd(d){
  return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
}
function fmtNum(n){ return n.toLocaleString(); }

// ---------- main aggregation, all computed client-side from raw scrobbles ----------
function render(){
  const s = SCROBBLES.slice().sort((a,b)=>a.date-b.date);
  const n = s.length;

  const firstMs = s[0].date, lastMs = s[n-1].date;
  const spanDays = Math.round((lastMs-firstMs)/86400000);

  // local-date bucketing
  const dateSet = new Set();
  const dailyCount = {};
  s.forEach(r=>{
    const key = ymd(localDate(r.date));
    dateSet.add(key);
    dailyCount[key] = (dailyCount[key]||0)+1;
  });
  const activeDays = dateSet.size;

  // longest streak of consecutive local dates
  const sortedDates = Array.from(dateSet).sort();
  let longestStreak = 1, curStreak = 1;
  for(let i=1;i<sortedDates.length;i++){
    const prev = new Date(sortedDates[i-1]+'T00:00:00Z');
    const cur = new Date(sortedDates[i]+'T00:00:00Z');
    const diff = Math.round((cur-prev)/86400000);
    curStreak = (diff===1) ? curStreak+1 : 1;
    if(curStreak>longestStreak) longestStreak = curStreak;
  }
  if(sortedDates.length===0) longestStreak = 0;

  // unique artists + counts
  const artistCounts = {};
  const trackCounts = {}; // key: artist|||track
  const albumCounts = {}; // key: artist|||album
  const yearCounts = {};
  const hourCounts = {};
  const dowCounts = {};
  const firstSeenArtist = {};
  const dowNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  s.forEach(r=>{
    artistCounts[r.artist] = (artistCounts[r.artist]||0)+1;

    const tKey = r.artist+'|||'+r.track;
    trackCounts[tKey] = (trackCounts[tKey]||0)+1;

    if(r.album){
      const aKey = r.artist+'|||'+r.album;
      albumCounts[aKey] = (albumCounts[aKey]||0)+1;
    }

    const ld = localDate(r.date);
    const year = new Date(r.date).getUTCFullYear();
    yearCounts[year] = (yearCounts[year]||0)+1;

    const hour = ld.getUTCHours();
    hourCounts[hour] = (hourCounts[hour]||0)+1;

    const dow = dowNames[ld.getUTCDay()];
    dowCounts[dow] = (dowCounts[dow]||0)+1;

    if(!(r.artist in firstSeenArtist) || r.date < firstSeenArtist[r.artist]){
      firstSeenArtist[r.artist] = r.date;
    }
  });

  const uniqueArtists = Object.keys(artistCounts).length;

  const topArtists = Object.entries(artistCounts).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([artist,count])=>({artist,count}));

  const topTracks = Object.entries(trackCounts).sort((a,b)=>b[1]-a[1]).slice(0,10)
    .map(([key,count])=>{ const [artist,track]=key.split('|||'); return {artist,track,count}; });

  const topAlbums = Object.entries(albumCounts).sort((a,b)=>b[1]-a[1]).slice(0,8)
    .map(([key,count])=>{ const [artist,album]=key.split('|||'); return {artist,album,count}; });

  const yearly = Object.keys(yearCounts).map(Number).sort((a,b)=>a-b)
    .map(y=>({year:y, count:yearCounts[y]}));

  const hourOfDay = Array.from({length:24},(_,h)=>({hour:h, count:hourCounts[h]||0}));

  const dowOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const dayOfWeek = dowOrder.map(d=>({day:d, count:dowCounts[d]||0}));

  const discoveryByYear = {};
  Object.values(firstSeenArtist).forEach(ms=>{
    const y = new Date(ms).getUTCFullYear();
    discoveryByYear[y] = (discoveryByYear[y]||0)+1;
  });
  const discovery = Object.keys(discoveryByYear).map(Number).sort((a,b)=>a-b)
    .map(y=>({year:y, count:discoveryByYear[y]}));

  // ---------- Canadian content, only if country map loaded ----------
  let canStats = null;
  if(ARTIST_COUNTRY){
    const countryNorm = {};
    Object.keys(ARTIST_COUNTRY).forEach(k=>{ countryNorm[normArtist(k)] = ARTIST_COUNTRY[k]; });

    let matched=0, canYearCounts={}, canYearTotal={}, canTotal=0, canMatched=0;
    let last30Total=0, last30Can=0;
    const cutoff30 = lastMs - 30*86400000;

    s.forEach(r=>{
      const country = countryNorm[normArtist(r.artist)];
      if(country===undefined) return;
      matched++;
      const isCan = /canada/i.test(country);
      const year = new Date(r.date).getUTCFullYear();
      canYearTotal[year] = (canYearTotal[year]||0)+1;
      if(isCan){ canYearCounts[year]=(canYearCounts[year]||0)+1; canTotal++; }
      canMatched++;
      if(r.date>=cutoff30){ last30Total++; if(isCan) last30Can++; }
    });

    const yearlyCanadian = Object.keys(canYearTotal).map(Number).sort((a,b)=>a-b).map(y=>({
      year:y, pct: Math.round((canYearCounts[y]||0)/canYearTotal[y]*1000)/10
    }));

    canStats = {
      matchRate: matched/n*100,
      lifetimePct: canMatched ? Math.round(canTotal/canMatched*1000)/10 : null,
      recentPct: last30Total ? Math.round(last30Can/last30Total*1000)/10 : null,
      yearlyCanadian
    };
  }

  paint({
    username: (raw_username()),
    total_scrobbles:n, unique_artists:uniqueArtists, first_date: ymd(new Date(firstMs)),
    last_date: ymd(new Date(lastMs)), span_days: spanDays, active_days: activeDays,
    longest_streak: longestStreak, yearly, top_artists: topArtists, top_tracks: topTracks,
    top_albums: topAlbums, hour_of_day: hourOfDay, day_of_week: dayOfWeek, discovery,
    can: canStats
  });
}

function raw_username(){ return document.getElementById('heroUser').textContent; }

// ---------- painting / charts ----------
function paint(DATA){
  Chart.defaults.color = '#a4937f';
  Chart.defaults.font.family = "'Work Sans', sans-serif";
  Chart.defaults.font.size = 11.5;
  Chart.defaults.borderColor = '#3a2f24';

  const GOLD = '#d6a24c';
  const GOLD_DIM = 'rgba(214,162,76,0.35)';
  const TEAL = '#5a9a94';
  const TEAL_DIM = 'rgba(90,154,148,0.35)';
  const RED = '#c0392b';

  document.getElementById('heroScrobbles').textContent = fmtNum(DATA.total_scrobbles);
  const years = (DATA.span_days/365.25).toFixed(1);
  document.getElementById('heroSpan').textContent = years + ' years';
  document.getElementById('heroDates').textContent = DATA.first_date + ' to ' + DATA.last_date;

  const stats = [
    [fmtNum(DATA.total_scrobbles), 'total scrobbles'],
    [DATA.unique_artists, 'unique artists'],
    [DATA.active_days, 'active listening days'],
    [DATA.longest_streak + 'd', 'longest streak'],
  ];
  if(DATA.can){
    stats.push([DATA.can.lifetimePct!=null ? DATA.can.lifetimePct+'%' : '—', 'lifetime Canadian']);
    stats.push([DATA.can.recentPct!=null ? DATA.can.recentPct+'%' : '—', 'last 30 days Canadian']);
  }
  document.getElementById('statGrid').innerHTML = stats.map(s =>
    `<div class="stat-card"><div class="stat-val">${s[0]}</div><div class="stat-lbl">${s[1]}</div></div>`
  ).join('');

  document.getElementById('factStreak').textContent = DATA.longest_streak;
  document.getElementById('factArtists').textContent = DATA.unique_artists;
  document.getElementById('factActive').textContent = Math.round(DATA.active_days/DATA.span_days*100) + '%';
  const top10sum = DATA.top_artists.slice(0,10).reduce((a,b)=>a+b.count,0);
  document.getElementById('factTop10').textContent = Math.round(top10sum/DATA.total_scrobbles*100) + '%';

  // year chart
  new Chart(document.getElementById('yearChart'), {
    type:'bar',
    data:{ labels: DATA.yearly.map(d=>d.year),
      datasets:[{ data: DATA.yearly.map(d=>d.count), backgroundColor: GOLD_DIM, borderRadius:2, barPercentage:0.7 }] },
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.parsed.y.toLocaleString()+' scrobbles' } } },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'}, ticks:{ callback: v => v>=1000? (v/1000)+'k': v } } } }
  });

  // Canadian content -- only render if data available
  if(DATA.can && DATA.can.yearlyCanadian.length){
    document.getElementById('canChartCard').style.display = 'block';
    new Chart(document.getElementById('canChart'), {
      type:'line',
      data:{ labels: DATA.can.yearlyCanadian.map(d=>d.year),
        datasets:[
          { data: DATA.can.yearlyCanadian.map(d=>d.pct), borderColor: RED, backgroundColor:'rgba(192,57,43,0.12)', fill:true, tension:0.3, pointRadius:3, pointBackgroundColor: RED },
          { data: DATA.can.yearlyCanadian.map(()=>35), borderColor:'#5a6a5a', borderDash:[4,4], pointRadius:0, borderWidth:1 }
        ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: c => c.datasetIndex===0 ? c.parsed.y+'% Canadian' : '35% target' } } },
        scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'}, ticks:{ callback: v=>v+'%' }, suggestedMax:40 } } }
    });
    const co = document.getElementById('canCallout');
    co.style.display = 'block';
    co.innerHTML = `Lifetime average sits at <b>${DATA.can.lifetimePct}%</b> Canadian (matched ${DATA.can.matchRate.toFixed(1)}% of scrobbles to a known artist country). Last 30 days: <b>${DATA.can.recentPct}%</b>.`;
    document.getElementById('countryPendingNotice').style.display = 'none';
  } else {
    document.getElementById('countryPendingNotice').style.display = 'block';
  }

  function renderList(elId, items, mainFn, subFn){
    document.getElementById(elId).innerHTML = items.map((it,i)=>`
      <li>
        <span class="rank-num">${String(i+1).padStart(2,'0')}</span>
        <div class="rank-main">
          <div class="rank-title">${mainFn(it)}</div>
          ${subFn(it) ? `<div class="rank-sub">${subFn(it)}</div>` : ''}
        </div>
        <span class="rank-count">${fmtNum(it.count)}</span>
      </li>`).join('');
  }
  renderList('artistList', DATA.top_artists, d=>d.artist, d=>'');
  renderList('trackList', DATA.top_tracks, d=>d.track, d=>d.artist);
  renderList('albumList', DATA.top_albums, d=>d.album, d=>d.artist);

  new Chart(document.getElementById('hourChart'), {
    type:'bar',
    data:{ labels: DATA.hour_of_day.map(d=> (d.hour%12===0?12:d.hour%12) + (d.hour<12?'a':'p')),
      datasets:[{ data: DATA.hour_of_day.map(d=>d.count), backgroundColor: TEAL_DIM, borderRadius:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false}, ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit:8 } }, y:{ grid:{color:'#241d16'} } } }
  });

  new Chart(document.getElementById('dowChart'), {
    type:'bar',
    data:{ labels: DATA.day_of_week.map(d=>d.day.slice(0,3)),
      datasets:[{ data: DATA.day_of_week.map(d=>d.count), backgroundColor: TEAL, borderRadius:3, barPercentage:0.6 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'} } } }
  });

  new Chart(document.getElementById('discoveryChart'), {
    type:'bar',
    data:{ labels: DATA.discovery.map(d=>d.year),
      datasets:[{ data: DATA.discovery.map(d=>d.count), backgroundColor: GOLD_DIM, borderRadius:2, barPercentage:0.7 }] },
    options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false} },
      scales:{ x:{ grid:{display:false} }, y:{ grid:{color:'#241d16'} } } }
  });
}

boot();
