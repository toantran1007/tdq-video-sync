# TDQ Video Sync

Ứng dụng Electron Windows đồng bộ video hoặc ảnh theo một trong hai nguồn thời lượng độc lập.

Ví dụ:

- `voice_001.mp3` ghép với `video_001.mp4`
- `voice_002.wav` ghép với `anh_002.jpg`

## Chế độ Âm thanh + Video/Ảnh

Ghép âm thanh và media theo cụm số cuối trong tên file. Video dài hơn voice sẽ bị cắt, video ngắn hơn được đổi tốc độ và ảnh tĩnh được kéo dài theo voice.

## Chế độ SRT + Video/Ảnh

- Không cần thư mục âm thanh.
- **Một file SRT:** từng cue SRT điều khiển media số 1, 2, 3… theo thứ tự tăng dần. Thời điểm chuyển media bám theo timeline tổng của SRT.
- **Thư mục SRT:** mỗi file SRT ghép với media cùng số, ví dụ `sub_001.srt` + `image_001.jpg`. Thời lượng media bằng mốc kết thúc cuối của file SRT đó.

Hai chế độ đều hỗ trợ xuất video riêng lẻ hoặc nối thành một MP4. Khi dùng SRT, ứng dụng chỉ lấy timeline để căn thời lượng và chuyển media; chữ phụ đề không được thêm vào video kết quả.

## Tăng tốc xử lý

- **Auto:** thử encode thực tế và tự dùng NVIDIA NVENC, Intel Quick Sync hoặc AMD AMF; nếu không có sẽ tự chuyển sang CPU.
- **GPU:** bắt buộc dùng GPU và báo lỗi rõ ràng nếu máy không hỗ trợ.
- **CPU:** dùng `libx264` với preset `veryfast` để ưu tiên tốc độ và độ tương thích.

Khi có nhiều cặp file, ứng dụng xử lý song song tối đa hai video để rút ngắn tổng thời gian.

## Chạy khi phát triển

Nhấp đúp `CHAY-APP-DEV.cmd` để mở ứng dụng trực tiếp mà không cần build EXE.

Hoặc chạy bằng terminal:

```powershell
npm.cmd install
npm.cmd start
```

## Đóng gói

```powershell
npm.cmd run dist
```

File EXE portable được tạo trong thư mục `dist`.
