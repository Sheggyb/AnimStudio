// Client for the local AnimStudio server (server.cjs).
async function j(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

export const api = {
  online: true,
  async ping() {
    try {
      await j('/api/info');
      this.online = true;
    } catch {
      this.online = false;
    }
    return this.online;
  },
  info: () => j('/api/info'),
  models: async () => (await j('/api/models')).models,
  projects: async () => (await j('/api/projects')).projects,
  loadProject: (name) => j(`/api/project?name=${encodeURIComponent(name)}`),
  saveProject: (name, data) => j(`/api/project?name=${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }),
  deleteProject: (name) => j(`/api/project?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  autosaveGet: (model) => j(`/api/autosave?model=${encodeURIComponent(model)}`),
  autosavePut: (model, data) => j(`/api/autosave?model=${encodeURIComponent(model)}`, { method: 'PUT', body: JSON.stringify(data) }),
  autosaveDelete: (model) => j(`/api/autosave?model=${encodeURIComponent(model)}`, { method: 'DELETE' }),
  exportFile: (name, blob) => j(`/api/export?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob }),
  library: () => j('/api/library'),
  libraryLoad: (file) => j(`/api/library/item?file=${encodeURIComponent(file)}`),
  librarySave: (file, data) => j(`/api/library/item?file=${encodeURIComponent(file)}`, { method: 'PUT', body: JSON.stringify(data) }),
  libraryDelete: (file) => j(`/api/library/item?file=${encodeURIComponent(file)}`, { method: 'DELETE' }),
  saveModel: (name, blob) => j(`/api/model?name=${encodeURIComponent(name)}`, { method: 'PUT', body: blob }),
  props: async () => (await j('/api/props')).props,
  saveProp: (name, blob) => j(`/api/prop?name=${encodeURIComponent(name)}`, { method: 'PUT', body: blob }),
  savePack: (name, blob) => j(`/api/animpack?name=${encodeURIComponent(name)}`, { method: 'PUT', body: blob }),
  deletePack: (name) => j(`/api/animpack?name=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  reveal: (path) => j(`/api/reveal?path=${encodeURIComponent(path)}`, { method: 'POST' }),
};
