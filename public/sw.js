// Service Worker — Sistema de Actas Mexicanas
// Maneja notificaciones push cuando el admin tiene el panel abierto o en segundo plano

self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title   = data.title || 'Sistema de Actas Mexicanas';
  const options = {
    body:    data.body || 'Nueva notificación',
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    vibrate: [200, 100, 200, 100, 200],
    tag:     'acta-notification',
    renotify: true,
    data:    { url: data.url || '/admin/panel.html' },
    actions: [
      { action: 'ver', title: '👁️ Ver panel' },
      { action: 'cerrar', title: 'Cerrar' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'cerrar') return;
  const url = event.notification.data?.url || '/admin/panel.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Si ya hay una ventana abierta, enfocarla
      for (const client of list) {
        if (client.url.includes('/admin/') && 'focus' in client) {
          return client.focus();
        }
      }
      // Si no, abrir una nueva
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
