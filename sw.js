/**
 * Service Worker — ทำ 2 อย่าง
 *   1. รับ Web Push แล้วแสดงการแจ้งเตือน (จำเป็นสำหรับ iOS 16.4+ หลัง Add to Home Screen)
 *   2. cache เปลือกแอปไว้ให้เปิดได้ตอนไม่มีเน็ต — ข้อมูลจริงอยู่ใน IndexedDB ไม่ได้ cache ที่นี่
 */
/* รหัสภายใน ไม่ได้ผูกกับชื่อแอปที่แสดงให้คนเห็น เปลี่ยนเลขท้ายเมื่อรายการ
   ไฟล์ที่ cache เปลี่ยน เพื่อให้ตัวเก่าถูกล้างทิ้งตอน activate */
const CACHE = 'moneyflow-shell-v4';
/* อ้างอิงจาก scope ของ service worker เอง ไม่ใช่ '/' ตายตัว
   เพราะ GitHub Pages เสิร์ฟแอปไว้ใต้โฟลเดอร์ (…/ชื่อ-repo/) ไม่ใช่ที่รากโดเมน
   ถ้าใช้ '/' ตายตัว มันจะไป cache หน้าแรกของโดเมนแทนตัวแอป แล้วเปิดออฟไลน์ไม่ติด */
const ROOT = new URL('./', self.registration.scope).pathname;
const INDEX = `${ROOT}index.html`;
const SHELL = [ROOT, INDEX, `${ROOT}manifest.webmanifest`];

/* ไฟล์นิ่งที่ cache ได้ ดูจากนามสกุล ไม่ใช่จากชื่อโฟลเดอร์
   เดิมเช็กว่าอยู่ใต้ assets/ หรือ icons/ ซึ่งผูกกับผังไฟล์แบบเดียว
   พอเอาไปวางแบบแบน (ทุกไฟล์อยู่รากเดียวกัน เพื่อให้อัปโหลดจากมือถือได้)
   เงื่อนไขนั้นเป็นเท็จหมด แล้วออฟไลน์ก็เปิดไม่ติดโดยไม่มีอะไรฟ้อง */
const STATIC = /\.(js|css|png|svg|webmanifest|woff2?|json)$/;

/* ห้าม skipWaiting() ตรงนี้
   เดิมตัวใหม่แย่งคุมหน้าทันทีที่ติดตั้งเสร็จ ทั้งที่หน้าเดิมยังรันโค้ดเก่าอยู่
   แล้ว activate ก็ลบ cache เก่าทิ้ง พอหน้าเดิมเรียกไฟล์ที่โหลดทีหลัง
   (กองบัตร 3 มิติเป็น dynamic import) ไฟล์นั้นหายไปแล้วทั้งใน cache และบนเซิร์ฟเวอร์
   เพราะชื่อไฟล์มีแฮชและ deploy รอบใหม่ทับไปแล้ว — กดแล้วพังโดยไม่มีเหตุผลให้เห็น
   ตัวใหม่จึงต้องรอ จนกว่าคนใช้จะกดปุ่มอัปเดตเอง (ดู lib/appUpdate.ts)

   addAll เป็น all-or-nothing — ถ้ามีสักไฟล์ที่ 404 การติดตั้งจะล้มทั้งชุด
   แล้วแอปจะเปิดออฟไลน์ไม่ได้เลย ทั้งที่ไฟล์ที่ขาดอาจเป็นแค่ไอคอน
   เก็บทีละไฟล์แล้วปล่อยตัวที่พลาดไป ดีกว่าไม่ได้ cache อะไรเลย */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((url) => c.add(url)))),
  );
});

/* หน้าเว็บส่งสัญญาณมาว่าพร้อมให้เปลี่ยนตัวแล้ว */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // ห้าม cache คำขอ API เด็ดขาด ไม่งั้นจะเห็นยอดเงินเก่าค้างอยู่
  if (url.origin !== self.location.origin) return;

  // เอกสาร HTML: ลองเน็ตก่อน ถ้าไม่มีค่อยใช้ของใน cache (network-first)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(INDEX, copy));
          return res;
        })
        .catch(() => caches.match(INDEX)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
      if (res.ok && url.pathname.startsWith(ROOT) && STATIC.test(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    })),
  );
});

self.addEventListener('push', (event) => {
  let payload = { title: 'Spare', body: '' };
  try {
    if (event.data) payload = event.data.json();
  } catch {
    payload.body = event.data ? event.data.text() : '';
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Spare', {
      body: payload.body ?? '',
      /* ต้องอิง ROOT ไม่ใช่ '/' ตายตัว — แอปที่อยู่ใต้โฟลเดอร์ย่อยจะหาไอคอนไม่เจอ
         แล้วการแจ้งเตือนจะขึ้นแบบไม่มีรูปโดยไม่มีอะไรบอกว่าทำไม */
      icon: `${ROOT}icon-192.png`,
      badge: `${ROOT}icon-192.png`,
      tag: payload.tag,
      data: { url: payload.url ?? ROOT },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? ROOT;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
