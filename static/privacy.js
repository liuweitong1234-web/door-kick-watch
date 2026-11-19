(function () {
  'use strict';
  fetch('/api/config')
    .then((res) => (res.ok ? res.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      if (cfg.site_name) {
        document.querySelectorAll('[data-site-name]').forEach((el) => { el.textContent = cfg.site_name; });
        document.title = `Privacy · ${cfg.site_name}`;
      }
      if (cfg.contact_email) {
        const link = document.createElement('a');
        link.href = `mailto:${cfg.contact_email}`;
        link.textContent = cfg.contact_email;
        document.querySelectorAll('[data-contact]').forEach((el) => el.replaceChildren(link.cloneNode(true)));
      }
    })
    .catch(() => { /* keep the generic wording */ });
})();
