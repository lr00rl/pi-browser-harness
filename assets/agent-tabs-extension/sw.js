// Driven over CDP by pi-browser-harness (src/cdp/tab-group.ts): it has no UI and listens to no events. The harness
// attaches to this worker and calls the two functions below with Runtime.evaluate.

let chain = Promise.resolve();

// Calls run one at a time, so two tabs opened together cannot each create a group with the same title.
const serialize = (task) => {
  const run = chain.then(task);
  chain = run.catch(() => undefined);
  return run;
};

const lastNormalWindowId = async () => {
  const focused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  if (focused && focused.id !== undefined && !focused.incognito) return focused.id;
  const all = await chrome.windows.getAll({ windowTypes: ["normal"] });
  return all.find((w) => !w.incognito)?.id;
};

// Opens `url` as a background tab and puts it in the group titled `title`. The group's own window wins, so a session's
// tabs stay together even after the user focuses another window; a new group goes to the last-focused window.
self.piOpenTab = (url, title, color) =>
  serialize(async () => {
    const [existing] = await chrome.tabGroups.query({ title });
    const windowId = existing ? existing.windowId : await lastNormalWindowId();
    let tab;
    if (windowId === undefined) {
      const win = await chrome.windows.create({ url, focused: false });
      tab = win.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId, url, active: false });
    }
    const groupId = existing
      ? await chrome.tabs.group({ groupId: existing.id, tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    if (!existing) await chrome.tabGroups.update(groupId, { title, color });
    return { ok: true, groupId, tabId: tab.id };
  }).catch((e) => ({ ok: false, reason: String((e && e.message) || e) }));

// Closes a tab this extension opened whose CDP target the harness could not find, so it is not left in the group.
self.piCloseTab = (tabId) => chrome.tabs.remove(tabId).then(() => true, () => false);

// The signed-in account of the profile this extension runs in, so the harness can confirm it is the pinned profile.
self.piProfileEmail = async () => (await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" })).email;
