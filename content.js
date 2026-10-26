(() => {
  "use strict";

  function getCookie(name) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|; )${escapedName}=([^;]*)`));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function getCsrfToken() {
    const raw = getCookie("JSESSIONID");
    return raw ? raw.replace(/"/g, "") : null;
  }

  function getIdentityHeader() {
    const meta = document.querySelector('meta[name="li-identity"]');
    if (meta) return meta.content;
    const authCtx = getCookie("li_ep_auth_context");
    if (!authCtx) return null;
    try {
      const decoded = atob(authCtx.split("\x01")[0]);
      const aid = decoded.match(/aid=(\d+)/);
      const pid = decoded.match(/pid=(\d+)/);
      if (aid && pid) return btoa(`urn:li:enterpriseProfile:(urn:li:enterpriseAccount:${aid[1]},${pid[1]})`);
    } catch {}
    return null;
  }

  function extractCourseSlug() {
    const m = window.location.pathname.match(/^\/learning\/([^/]+)/);
    return m ? decodePathPart(m[1]) : null;
  }

  function extractVideoSlug() {
    const m = window.location.pathname.match(/^\/learning\/[^/]+\/([^/]+)/);
    return m ? decodePathPart(m[1]) : null;
  }

  function decodePathPart(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getUParam() {
    const authCtx = getCookie("li_ep_auth_context");
    if (!authCtx) return "";
    try {
      const decoded = atob(authCtx.split("\x01")[0]);
      const m = decoded.match(/aid=(\d+)/);
      return m ? m[1] : "";
    } catch { return ""; }
  }

  // ── API ───────────────────────────────────────────────────────────
  async function apiFetch(url) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error("Not logged in");
    const identity = getIdentityHeader();
    const h = {
      accept: "application/vnd.linkedin.normalized+json+2.1",
      "csrf-token": csrf,
      "x-restli-protocol-version": "2.0.0",
    };
    if (identity) h["x-li-identity"] = identity;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let r;
    try {
      r = await fetch(url, {
        headers: h,
        credentials: "include",
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("LinkedIn API request timed out");
      throw new Error(`LinkedIn API request failed: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!r.ok) {
      const reason = r.status === 401 || r.status === 403
        ? "LinkedIn session expired or access was denied"
        : `LinkedIn API returned HTTP ${r.status}`;
      throw new Error(reason);
    }
    try {
      return await r.json();
    } catch {
      throw new Error("LinkedIn returned an invalid API response");
    }
  }

  async function fetchCourseVideos(courseSlug) {
    const data = await apiFetch(
      `https://www.linkedin.com/learning-api/detailedCourses?addParagraphsToTranscript=false&courseSlug=${encodeURIComponent(courseSlug)}&q=slugs&trimCourseVideos=false`
    );
    const included = Array.isArray(data.included) ? data.included : [];
    const course = included.find((i) => i.$type === "com.linkedin.learning.api.DetailedCourse");
    if (!Array.isArray(course?.chapters)) throw new Error("No chapters found");

    // Build status lookup — try both cachingKey and by matching video URN
    const statusByCachingKey = {};
    const statusByUrn = {};
    for (const item of included) {
      if (item.$type === "com.linkedin.learning.api.interaction.ConsistentBasicVideoViewingStatus") {
        if (item.cachingKey) statusByCachingKey[item.cachingKey] = item;
        const itemStr = JSON.stringify(item);
        const urnMatch = itemStr.match(/urn:li:lyndaVideo[^"\\]*/);
        if (urnMatch) statusByUrn[urnMatch[0]] = item;
      }
    }

    const uParam = getUParam();
    const videos = [];
    for (const ch of course.chapters) {
      if (!Array.isArray(ch.videos)) continue;
      for (const v of ch.videos) {
        if (!v?.slug || !v?.title) continue;
        let state = "NOT_STARTED";

        // Try multiple ways to find the viewing status
        const viewingRef = v["*viewingStatus"] || "";
        const st =
          statusByCachingKey[viewingRef] ||
          statusByUrn[v.urn] ||
          null;

        if (st?.details?.statusType) {
          state = st.details.statusType;
        }

        videos.push({
          title: v.title,
          slug: v.slug,
          courseSlug,
          durationInSeconds: v.durationInSeconds,
          completed: state === "COMPLETED",
          uParam,
        });
      }
    }

    const completedCount = videos.filter((v) => v.completed).length;
    console.log(`[LinkedLearn] ${videos.length} videos: ${completedCount} completed, ${videos.length - completedCount} remaining`);

    return videos;
  }

  // ── Video player (only used in job tabs) ──────────────────────────
  const TARGET_RATE = 10;

  function findVideo() {
    return document.querySelector("video.vjs-tech") ||
           document.querySelector("video[class*='video']") ||
           document.querySelector("video");
  }

  async function waitForVideo(timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = findVideo();
      if (v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) return v;
      await sleep(500);
    }
    throw new Error("Video player not ready");
  }

  function setSpeed(rate) {
    window.dispatchEvent(new CustomEvent("linkedlearn-set-speed", { detail: { rate } }));
  }

  async function startPlayback(video, attempts = 3) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await video.play();
        return;
      } catch (error) {
        lastError = error;
        await sleep(1000);
      }
    }
    throw new Error(`Could not start video playback: ${lastError?.message || "unknown error"}`);
  }

  async function playVideoToCompletion() {
    const video = await waitForVideo();
    const duration = video.duration;

    console.log(`[LinkedLearn] Playing — ${duration.toFixed(1)}s`);

    video.muted = true;
    if (video.seekable.length > 0) {
      video.currentTime = video.seekable.start(0);
    } else {
      video.currentTime = 0;
    }

    setSpeed(TARGET_RATE);
    const enforceInterval = setInterval(() => setSpeed(TARGET_RATE), 1000);

    try {
      await new Promise((resolve, reject) => {
        const timeoutMs = Math.max((duration / TARGET_RATE) * 1000 + 15000, 30000);
        const timeout = setTimeout(() => finish(new Error("Video playback timed out")), timeoutMs);
        let resumeTimer = null;
        let settled = false;

        function finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (resumeTimer) clearTimeout(resumeTimer);
          video.removeEventListener("ended", onEnded);
          video.removeEventListener("pause", onPause);
          if (error) reject(error);
          else resolve();
        }

        function onEnded() {
          finish();
        }

        function onPause() {
          if (video.ended || settled) return;
          if (resumeTimer) clearTimeout(resumeTimer);
          resumeTimer = setTimeout(() => {
            startPlayback(video).catch((error) => finish(error));
          }, 500);
        }

        video.addEventListener("ended", onEnded);
        video.addEventListener("pause", onPause);
        if (video.ended) finish();

        startPlayback(video).catch((error) => finish(error));
      });

      console.log("[LinkedLearn] Video ended");
    } finally {
      clearInterval(enforceInterval);
    }
  }

  // ── Job tab auto-play ─────────────────────────────────────────────
  async function checkIfJobTab() {
    const videoSlug = extractVideoSlug();
    if (!videoSlug) return;

    try {
      const resp = await chrome.runtime.sendMessage({ type: "AM_I_JOB_TAB" });
      if (!resp?.isJobTab) return;
    } catch {
      return;
    }

    console.log("[LinkedLearn] This is a job tab — auto-playing...");

    try {
      await playVideoToCompletion();
      chrome.runtime.sendMessage({ type: "VIDEO_DONE", title: videoSlug });
    } catch (err) {
      console.error("[LinkedLearn] Failed:", err.message);
      chrome.runtime.sendMessage({ type: "VIDEO_DONE", title: videoSlug, error: err.message });
    }
  }

  // ── Messages from popup (only the original tab handles these) ─────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "GET_COURSE_INFO") {
      handleGetCourseInfo()
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (msg.type === "COMPLETE_REMAINING" || msg.type === "COMPLETE_ALL") {
      const skipCompleted = msg.type === "COMPLETE_REMAINING";
      const videos = Array.isArray(msg.videos) ? msg.videos : [];
      const toComplete = skipCompleted ? videos.filter((v) => !v.completed) : videos;
      // Send directly to background — do NOT relay through content script
      chrome.runtime.sendMessage({ type: "START_JOB", videos: toComplete })
        .then(() => sendResponse({ started: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (msg.type === "CANCEL") {
      chrome.runtime.sendMessage({ type: "CANCEL_JOB" })
        .then(() => sendResponse({ cancelled: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
  });

  async function handleGetCourseInfo() {
    const slug = extractCourseSlug();
    if (!slug) return { error: "Not on a LinkedIn Learning course page." };
    try {
      const videos = await fetchCourseVideos(slug);
      if (videos.length === 0) return { slug, videos: [], error: "No videos found." };

      let jobStatus = null;
      try { jobStatus = await chrome.runtime.sendMessage({ type: "GET_JOB_STATUS" }); } catch {}

      return {
        slug,
        totalVideos: videos.length,
        completedVideos: videos.filter((v) => v.completed).length,
        videos,
        activeJob: jobStatus,
      };
    } catch (err) {
      return { error: err.message, slug };
    }
  }

  // Only auto-play if this is a job tab (opened by the background)
  setTimeout(() => checkIfJobTab(), 3000);
})();
