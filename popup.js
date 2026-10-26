(() => {
  "use strict";

  let courseVideos = [];
  const $ = (sel) => document.querySelector(sel);

  function showView(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    document.getElementById(id)?.classList.add("active");
  }

  async function sendToContent(msg) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab");
    return chrome.tabs.sendMessage(tab.id, msg);
  }

  async function init() {
    showView("view-loading");
    try {
      const info = await sendToContent({ type: "GET_COURSE_INFO" });

      if (info.error && (!info.videos || info.videos.length === 0)) {
        $("#error-msg").textContent = info.error;
        showView("view-error");
        return;
      }

      if (!info.videos || info.videos.length === 0) {
        $("#error-msg").textContent = "No videos found. Navigate into a video first.";
        showView("view-error");
        return;
      }

      // Check active job
      if (info.activeJob && info.activeJob.done + info.activeJob.failed < info.activeJob.total) {
        const j = info.activeJob;
        showView("view-progress");
        const pct = j.total > 0 ? ((j.done + j.failed) / j.total) * 100 : 0;
        $("#progress-fill").style.width = `${pct}%`;
        $("#progress-count").textContent = `${j.done + j.failed} / ${j.total}`;
        $("#progress-current").textContent = "4 videos playing in parallel...";
        $("#progress-timer").textContent = "Videos play at 10x in background tabs.";
        return;
      }

      courseVideos = info.videos;
      const total = info.totalVideos;
      const completed = info.completedVideos;
      const remaining = total - completed;

      $("#total-videos").textContent = total;
      $("#completed-videos").textContent = completed;
      $("#remaining-videos").textContent = remaining;

      if (remaining === 0) {
        $("#btn-complete-remaining").textContent = "All Done!";
        $("#btn-complete-remaining").disabled = true;
      }

      showView("view-course");
    } catch (err) {
      $("#error-msg").textContent =
        `Could not connect: ${err.message}\n\nRefresh the LinkedIn Learning page and try again.`;
      showView("view-error");
    }
  }

  $("#btn-retry").addEventListener("click", init);

  $("#btn-complete-remaining").addEventListener("click", async () => {
    await startJob("COMPLETE_REMAINING");
  });

  $("#btn-complete-all").addEventListener("click", async () => {
    await startJob("COMPLETE_ALL");
  });

  async function startJob(type) {
    startProgress();
    try {
      const response = await sendToContent({ type, videos: courseVideos });
      if (response?.error) throw new Error(response.error);
      $("#progress-current").textContent = "Opening 4 tabs...";
      $("#progress-timer").textContent = "Videos play at 10x in parallel background tabs.";
    } catch (err) {
      $("#error-msg").textContent = `Could not start job: ${err.message}`;
      showView("view-error");
    }
  }

  $("#btn-reload").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.reload(tab.id);
    window.close();
  });

  function startProgress() {
    showView("view-progress");
    $("#progress-fill").style.width = "0%";
    $("#progress-count").textContent = "0 / ?";
    $("#progress-current").textContent = "Starting...";
    $("#progress-timer").textContent = "";
    $("#progress-errors").innerHTML = "";
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROGRESS") {
      const pct = msg.total > 0 ? ((msg.done + msg.failed) / msg.total) * 100 : 0;
      $("#progress-fill").style.width = `${pct}%`;
      $("#progress-count").textContent = `${msg.done + msg.failed} / ${msg.total}`;
      $("#progress-current").textContent = msg.current || "Playing...";
      $("#progress-timer").textContent = "4 tabs running at 10x speed";
    }

    if (msg.type === "DONE") {
      const lines = [`Completed ${msg.done} of ${msg.total} videos.`];
      if (msg.failed > 0) lines.push(`${msg.failed} failed.`);
      $("#done-text").textContent = lines.join(" ");
      showView("view-done");
    }
  });

  init();
})();
