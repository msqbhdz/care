(function () {
  var s = document.getElementById('stage');
  if (!s) { return 'NO_STAGE'; }
  s.classList.add('on');
  s.classList.add('vis');
  window.__care.burst(210, 180);
  window.__care.burst(120, 250);
  for (var i = 0; i < 35; i++) { window.__care.drawOnce(); }
  return 'ok';
})()