/* Music Library augmentation for Music-Library-Statistics.
 *
 * Requires:
 *   - Chart.js (already loaded by the existing index.html)
 *   - library_data.json in the same directory
 *
 * Add this immediately before listening_report.js in index.html:
 *   <script src="library_augmentation.js"></script>
 */

(async function () {
  "use strict";

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const toSeconds = (value) => {
    const [m, s] = String(value).split(":").map(Number);
    return (m || 0) * 60 + (s || 0);
  };

  const formatDuration = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  };

  const normArtist = (s) => String(s).toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^the /, "");

  try {
    const response = await fetch("./library_data.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const library = await response.json();
    const tracks = Array.isArray(library.tracks) ? library.tracks : [];
    if (!tracks.length) throw new Error("library_data.json contains no tracks");

    const artists = [...new Set(tracks.map(t => t.artist))];
    const albums = [...new Set(tracks.map(t => `${t.artist}|||${t.album}`))];
    const totalSeconds = tracks.reduce((sum, t) => sum + toSeconds(t.length), 0);
    const canadianTracks = tracks.filter(t => /canada/i.test(t.artistCountry)).length;

    const yearCounts = {};
    const decadeCounts = {};
    const countryCounts = {};

    for (const t of tracks) {
      yearCounts[t.year] = (yearCounts[t.year] || 0) + 1;
      const decade = Math.floor(t.year / 10) * 10;
      decadeCounts[decade] = (decadeCounts[decade] || 0) + 1;

      for (const country of String(t.artistCountry).split(";").map(x => x.trim()).filter(Boolean)) {
        countryCounts[country] = (countryCounts[country] || 0) + 1;
      }
    }

    // Use the library metadata to enrich the existing Top Tracks / Top Albums lists.
    const trackMeta = new Map(
      tracks.map(t => [`${normArtist(t.artist)}|||${t.title.toLowerCase()}`, t])
    );

    const enrichExistingLists = () => {
      document.querySelectorAll("#trackList li").forEach(li => {
        const artist = li.querySelector(".rank-sub")?.textContent || "";
        const title = li.querySelector(".rank-title")?.textContent || "";
        const meta = trackMeta.get(`${normArtist(artist)}|||${title.toLowerCase()}`);
        if (!meta) return;

        const sub = li.querySelector(".rank-sub");
        if (sub) {
          sub.textContent = `${meta.artist} · ${meta.year} · ${meta.artistCountry}`;
        }
      });

      document.querySelectorAll("#artistList li").forEach(li => {
        const artist = li.querySelector(".rank-title")?.textContent || "";
        const meta = tracks.find(t => t.artist === artist);
        if (!meta) return;

        const sub = document.createElement("div");
        sub.className = "rank-sub";
        sub.textContent = `${meta.artistCountry} · ${tracks.filter(t => t.artist === artist).length} library tracks`;
        li.querySelector(".rank-main")?.appendChild(sub);
      });
    };

    // Wait until the existing Last.fm report has rendered its lists.
    setTimeout(enrichExistingLists, 0);

    const section = document.createElement("section");
    section.id = "libraryCollection";
    section.innerHTML = `
      <div class="side">
        <span class="side-label">Side C</span>
        <div class="side-line"></div>
      </div>
      <p class="side-title" style="margin-top:-24px;margin-bottom:24px;">The Collection</p>

      <div class="stat-grid">
        <div class="stat-card"><div class="stat-val">${tracks.length.toLocaleString()}</div><div class="stat-lbl">library tracks</div></div>
        <div class="stat-card"><div class="stat-val">${albums.length.toLocaleString()}</div><div class="stat-lbl">albums</div></div>
        <div class="stat-card"><div class="stat-val">${artists.length.toLocaleString()}</div><div class="stat-lbl">artists</div></div>
        <div class="stat-card"><div class="stat-val">${formatDuration(totalSeconds)}</div><div class="stat-lbl">total library duration</div></div>
        <div class="stat-card"><div class="stat-val">${canadianTracks.toLocaleString()}</div><div class="stat-lbl">Canadian-content tracks (${(canadianTracks / tracks.length * 100).toFixed(1)}%)</div></div>
        <div class="stat-card"><div class="stat-val">${Math.min(...tracks.map(t => t.year))}–${Math.max(...tracks.map(t => t.year))}</div><div class="stat-lbl">release-year span</div></div>
      </div>

      <div class="two-col">
        <div class="card">
          <h3>Tracks by release year</h3>
          <p class="desc">Library tracks grouped by the release year supplied in the library metadata.</p>
          <div class="chart-box tall"><canvas id="libraryYearChart"></canvas></div>
        </div>
        <div class="card">
          <h3>Tracks by artist country</h3>
          <p class="desc">A track is counted once for each country attached to its artist metadata.</p>
          <div class="chart-box tall"><canvas id="libraryCountryChart"></canvas></div>
        </div>
      </div>

      <div class="card">
        <h3>Library metadata</h3>
        <p class="desc">Every track from the supplied library export, including release year, artist country, length, play count, and last played date.</p>
        <input id="librarySearch" type="search" placeholder="Search title, artist, album, year, or country…"
          style="width:100%;padding:12px 14px;margin-bottom:14px;background:var(--surface-2);border:1px solid var(--hair);color:var(--text);font:inherit;">
        <div style="overflow:auto;max-height:620px;">
          <table id="libraryTable" style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr>
                <th style="text-align:left;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Title</th>
                <th style="text-align:left;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Artist</th>
                <th style="text-align:left;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Album</th>
                <th style="text-align:right;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Year</th>
                <th style="text-align:left;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Country</th>
                <th style="text-align:right;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Length</th>
                <th style="text-align:right;padding:9px;border-bottom:1px solid var(--hair);color:var(--muted);">Plays</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    `;

    const footer = document.querySelector("footer");
    footer?.parentNode.insertBefore(section, footer);

    const renderTable = (filter = "") => {
      const q = filter.trim().toLowerCase();
      const visible = tracks.filter(t => !q || [
        t.title, t.artist, t.album, t.year, t.artistCountry, t.length
      ].some(v => String(v).toLowerCase().includes(q)));

      document.querySelector("#libraryTable tbody").innerHTML = visible.map(t => `
        <tr>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);">${escapeHtml(t.title)}</td>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);">${escapeHtml(t.artist)}</td>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);">${escapeHtml(t.album)}</td>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);text-align:right;">${t.year}</td>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);">${escapeHtml(t.artistCountry)}</td>
          <td style="padding:8px 9px;border-bottom:1px solid var(--hair);text-align:right;">${escapeHtml(t.length)}</td>
        </tr>
      `).join("");
    };

    renderTable();
    document.querySelector("#librarySearch").addEventListener("input", e => renderTable(e.target.value));

    if (window.Chart) {
      const yearLabels = Object.keys(yearCounts).map(Number).sort((a, b) => a - b);
      const countries = Object.entries(countryCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);

      new Chart(document.getElementById("libraryYearChart"), {
        type: "bar",
        data: {
          labels: yearLabels,
          datasets: [{
            data: yearLabels.map(y => yearCounts[y]),
            backgroundColor: "rgba(214,162,76,0.35)",
            borderRadius: 2,
            barPercentage: 0.7
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false } },
            y: { grid: { color: "#241d16" } }
          }
        }
      });

      new Chart(document.getElementById("libraryCountryChart"), {
        type: "bar",
        data: {
          labels: countries.map(([country]) => country),
          datasets: [{
            data: countries.map(([, count]) => count),
            backgroundColor: "rgba(90,154,148,0.35)",
            borderRadius: 2
          }]
        },
        options: {
          indexAxis: "y",
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: "#241d16" } },
            y: { grid: { display: false } }
          }
        }
      });
    }
  } catch (error) {
    console.error("Failed to load library_data.json:", error);
  }
})();
