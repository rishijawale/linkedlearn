const CONCURRENCY = 4;

let job = null;
let nextJobId = 1;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!job || !job.activeTabs.has(tabId)) return;
  handleVideoDone(tabId, "Closed video tab", "Video tab was closed before completion");
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_JOB") {
    startJob(msg.videos);
    sendResponse({ started: true });
    return false;
  }

  if (msg.type === "VIDEO_DONE") {
    handleVideoDone(sender.tab?.id, msg.title, msg.error);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === "GET_JOB_STATUS") {
    sendResponse(job
      ? { done: job.done, failed: job.failed, total: job.total, remaining: job.queue.length }
      : null
    );
    return false;
  }

  if (msg.type === "CANCEL_JOB") {
    cancelJob();
    sendResponse({ cancelled: true });
    return false;
  }

  if (msg.type === "AM_I_JOB_TAB") {
    const tabId = sender.tab?.id;
    const isJobTab = !!(job && tabId && job.activeTabs.has(tabId));
    sendResponse({ isJobTab });
    return false;
  }
});

function startJob(videos) {
  if (job) cancelJob();

  const queue = Array.isArray(videos) ? videos.filter(isValidVideo) : [];
  job = {
    id: nextJobId++,
    queue,
    done: 0,
    failed: 0,
    total: queue.length,
    activeTabs: new Set(),
    tabToWindow: {},
    launching: 0,
  };

  console.log(`[LinkedLearn BG] Job: ${queue.length} videos, ${CONCURRENCY} windows`);
  if (queue.length === 0) {
    broadcastDone();
    job = null;
    return;
  }
  broadcastProgress();
  launchNextBatch();
}

function launchNextBatch() {
  if (!job) return;

  const currentJob = job;
  const slotsAvailable = CONCURRENCY - currentJob.activeTabs.size - currentJob.launching;
  const toLaunch = Math.min(slotsAvailable, currentJob.queue.length);

  for (let i = 0; i < toLaunch; i++) {
    const video = currentJob.queue.shift();
    currentJob.launching++;

    const url = `https://www.linkedin.com/learning/${video.courseSlug}/${video.slug}?autoSkip=true&resume=false&u=${video.uParam || ""}`;

    try {
      chrome.windows.create({
        url,
        type: "normal",
        width: 800,
        height: 600,
        focused: false,
      }, (win) => {
        if (job !== currentJob) return;
        currentJob.launching--;

        if (chrome.runtime.lastError || !win?.tabs?.[0]) {
          currentJob.failed++;
          console.error(`[LinkedLearn BG] Could not open "${video.title}": ${chrome.runtime.lastError?.message || "No tab created"}`);
          broadcastProgress();
          launchNextBatch();
          finishIfComplete();
          return;
        }

        const tabId = win.tabs[0].id;
        currentJob.activeTabs.add(tabId);
        currentJob.tabToWindow[tabId] = win.id;
        console.log(`[LinkedLearn BG] Window ${win.id} → "${video.title}"`);
        broadcastProgress();
      });
    } catch (err) {
      currentJob.launching--;
      currentJob.failed++;
      console.error(`[LinkedLearn BG] Could not open "${video.title}": ${err.message}`);
      launchNextBatch();
    }
  }
  finishIfComplete();
}

function handleVideoDone(tabId, title, error) {
  if (!job || !tabId || !job.activeTabs.has(tabId)) return;

  job.activeTabs.delete(tabId);

  if (error) {
    job.failed++;
    console.log(`[LinkedLearn BG] ✗ "${title}": ${error}`);
  } else {
    job.done++;
    console.log(`[LinkedLearn BG] ✓ "${title}" (${job.done}/${job.total})`);
  }

  // Close the window
  const winId = job.tabToWindow[tabId];
  delete job.tabToWindow[tabId];
  if (winId) chrome.windows.remove(winId).catch(() => {});

  broadcastProgress();

  if (job.queue.length > 0) {
    launchNextBatch();
  }
  finishIfComplete();
}

function cancelJob() {
  if (!job) return;
  const currentJob = job;
  job = null;
  for (const winId of Object.values(currentJob.tabToWindow)) {
    chrome.windows.remove(Number(winId)).catch(() => {});
  }
  console.log("[LinkedLearn BG] Cancelled");
}

function finishIfComplete() {
  if (!job || job.queue.length > 0 || job.activeTabs.size > 0 || job.launching > 0) return;
  broadcastDone();
  job = null;
}

function isValidVideo(video) {
  return video && typeof video.courseSlug === "string" &&
    typeof video.slug === "string" && video.courseSlug && video.slug;
}

function broadcastProgress() {
  if (!job) return;
  chrome.runtime.sendMessage({
    type: "PROGRESS",
    done: job.done,
    failed: job.failed,
    total: job.total,
    current: `${job.activeTabs.size} playing, ${job.queue.length} queued`,
  }).catch(() => {});
}

function broadcastDone() {
  if (!job) return;
  chrome.runtime.sendMessage({
    type: "DONE",
    done: job.done,
    failed: job.failed,
    total: job.total,
  }).catch(() => {});
}
