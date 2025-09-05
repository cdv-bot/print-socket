# Electron Printer Manager - Hướng dẫn chạy ứng dụng

Hệ thống bao gồm 3 phần chính:
1. **Bridge Server** - Server trung gian WebSocket
2. **Electron App** - Ứng dụng desktop quản lý máy in
3. **Web Client** - Giao diện web để gửi lệnh in

## Yêu cầu hệ thống

- Node.js (phiên bản 14 trở lên)
- npm hoặc yarn
- Windows (đã test trên Windows)

## Cài đặt

### 1. Cài đặt dependencies cho Electron App

```bash
npm install
```

### 2. Cài đặt dependencies cho Bridge Server

```bash
cd bridge-server
npm install
cd ..
```

## Chạy ứng dụng

### Bước 1: Khởi động Bridge Server

Mở terminal đầu tiên và chạy:

```bash
cd bridge-server
node server.js
```

Server sẽ chạy trên:
- HTTP: `http://localhost:3000`
- WebSocket: `ws://localhost:3000`

Bạn sẽ thấy thông báo:
```
Bridge Server running on port 3000
WebSocket server is ready
```

### Bước 2: Khởi động Electron App

Mở terminal thứ hai và chạy:

```bash
npm start
```

Electron app sẽ:
- Khởi động giao diện desktop
- Tự động kết nối với Bridge Server
- Đăng ký với tên "Printer Manager"

Bạn sẽ thấy log:
```
Electron app started
Connected to Bridge Server
Received welcome message
Registered as Printer Manager
```

### Bước 3: Mở Web Client

Có 2 cách để sử dụng Web Client:

#### Cách 1: Sử dụng file HTML trực tiếp

Mở file `print-client.html` trong trình duyệt:

```bash
start print-client.html
```

Hoặc mở bằng trình duyệt Edge:

```bash
msedge print-client.html
```

#### Cách 2: Sử dụng qua Bridge Server

Truy cập: `http://localhost:3000` trong trình duyệt

## Kiểm tra kết nối

### Test đơn giản

Mở file `simple-test.html` để kiểm tra kết nối cơ bản:

```bash
start simple-test.html
```

Nhấn nút "Send List Printers" để test.

### Kiểm tra log

1. **Bridge Server log**: Xem terminal chạy Bridge Server
2. **Electron App log**: Xem terminal chạy Electron hoặc Developer Tools
3. **Web Client log**: Mở Developer Tools trong trình duyệt (F12)

## Cách sử dụng

### Lấy danh sách máy in

1. Mở Web Client (`print-client.html`)
2. Nhấn nút "Get Printers"
3. Danh sách máy in sẽ hiển thị

### Gửi lệnh in

1. Chọn máy in từ danh sách
2. Nhập nội dung cần in
3. Nhấn nút "Print"
4. Kiểm tra kết quả trong log

## Cấu trúc thông điệp

### Tin nhắn từ Web Client đến Electron

```javascript
{
  type: 'direct_message',
  targetId: 'Printer Manager',
  data: {
    type: 'listPrinters', // hoặc 'print'
    id: 'unique-message-id'
    // ... các tham số khác
  }
}
```

### Phản hồi từ Electron đến Web Client

```javascript
{
  type: 'direct_message',
  targetId: 'web-client-id',
  data: {
    type: 'response',
    originalId: 'unique-message-id',
    success: true,
    data: [...] // kết quả
  }
}
```

## Xử lý sự cố

### Bridge Server không khởi động

- Kiểm tra port 3000 có bị chiếm không
- Chạy: `netstat -ano | findstr :3000`
- Nếu bị chiếm, thay đổi port trong `bridge-server/server.js`

### Electron App không kết nối

- Đảm bảo Bridge Server đã chạy trước
- Kiểm tra URL kết nối trong `main.js`
- Xem log lỗi trong terminal

### Web Client không hoạt động

- Kiểm tra Developer Tools (F12) để xem lỗi JavaScript
- Đảm bảo đã kết nối với đúng WebSocket URL
- Kiểm tra CORS nếu chạy qua HTTP server

### Tin nhắn không được gửi

- Kiểm tra tất cả 3 phần đã kết nối
- Xem log của Bridge Server để theo dõi routing
- Đảm bảo `targetId` và `clientId` đúng

## Files quan trọng

- `main.js` - Electron main process
- `bridge-server/server.js` - WebSocket bridge server
- `print-client.html` - Web client chính
- `simple-test.html` - Test client đơn giản
- `preload.js` - Electron preload script

## Phát triển thêm

### Thêm chức năng mới

1. Thêm handler trong `main.js` (Electron)
2. Cập nhật message routing trong `bridge-server/server.js`
3. Thêm UI và logic trong Web Client

### Debug

- Electron: Mở Developer Tools với `Ctrl+Shift+I`
- Bridge Server: Thêm `console.log` trong `server.js`
- Web Client: Sử dụng Browser Developer Tools

## Lưu ý bảo mật

- Hệ thống hiện tại chạy trên HTTP/WS (không mã hóa)
- Để production, cần cấu hình HTTPS/WSS
- Thêm authentication và authorization nếu cần
- Validate tất cả input từ Web Client

---

**Liên hệ hỗ trợ**: Nếu gặp vấn đề, hãy kiểm tra log của cả 3 phần và mô tả chi tiết lỗi.