// renderer/renderer.js
const sel = (q) => document.querySelector(q);
const tbody = sel('#printerTable tbody');
const printerSel = sel('#printerSel');
const summary = sel('#summary');
const msg = sel('#msg');

function renderRows(printers) {
  tbody.innerHTML = '';
  printers.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.name}</td>
      <td><span class="badge">${p.source || ''}</span></td>
      <td class="muted">${p.device || p.port || ''}</td>
      <td>${p.status ? `<span class="badge ${/idle|ok|ready/i.test(p.status)?'ok':/disabled|error|offline/i.test(p.status)?'err':'warn'}">${p.status}</span>` : ''}</td>
      <td>${p.isDefault ? '⭐' : ''}</td>
    `;
    tbody.appendChild(tr);
  });
}

function fillSelect(printers) {
  printerSel.innerHTML = '';
  printers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.isDefault ? `${p.name} (mặc định)` : p.name;
    printerSel.appendChild(opt);
  });
}

async function load() {
  msg.textContent = '';
  summary.textContent = 'Đang tải danh sách máy in...';
  try {
    const data = await window.printersAPI.listPrinters();
    if (data?.error) throw new Error(data.message || 'Lỗi không xác định');
    const arr = Array.isArray(data) ? data : [];
    renderRows(arr);
    fillSelect(arr);
    summary.textContent = `${arr.length} máy in tìm thấy.`;
  } catch (e) {
    summary.textContent = 'Không thể tải danh sách máy in.';
    msg.textContent = e.message;
  }
}

sel('#refresh').addEventListener('click', load);

sel('#setDefault').addEventListener('click', async () => {
  const name = printerSel.value;
  if (!name) return;
  msg.textContent = 'Đang đặt máy in mặc định...';
  const res = await window.printersAPI.setDefault(name);
  if (res?.ok) {
    msg.textContent = 'Đã đặt máy in mặc định thành công. Làm mới...';
    await load();
  } else {
    msg.textContent = 'Lỗi: ' + (res?.error || 'không xác định');
  }
});

sel('#printTest').addEventListener('click', async () => {
  const name = printerSel.value;
  if (!name) return;
  msg.textContent = 'Đang gửi trang thử in...';
  const res = await window.printersAPI.printTest(name);
  if (res?.ok) {
    msg.textContent = 'Đã gửi lệnh in trang thử.';
  } else {
    msg.textContent = 'Lỗi: ' + (res?.error || 'không xác định');
  }
});

window.addEventListener('DOMContentLoaded', load);