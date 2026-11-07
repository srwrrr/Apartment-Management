// Kept as a separate file because the site's security policy does not allow inline scripts.
document.getElementById('retry').addEventListener('click', function () {
  location.reload();
});

// FR-52: the emergency numbers the phone last saw. They are the only data the app keeps for offline use.
caches
  .match('/api/emergency-contacts')
  .then(function (res) {
    return res ? res.json() : null;
  })
  .then(function (data) {
    if (!data || !data.items || data.items.length === 0) return;
    var list = document.getElementById('contacts-list');
    data.items.forEach(function (c) {
      var item = document.createElement('li');
      var who = document.createElement('span');
      who.textContent = c.name + ' (' + c.role + ')';
      var call = document.createElement('a');
      call.href = 'tel:' + c.phone.replace(/[\s-]/g, '');
      call.textContent = c.phone;
      item.append(who, call);
      list.append(item);
    });
    document.getElementById('contacts').hidden = false;
  })
  .catch(function () {
    // Nothing saved yet: the page still says the phone is offline.
  });
