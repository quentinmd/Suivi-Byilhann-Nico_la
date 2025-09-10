// Configuration API front
// - En local (localhost, 127.0.0.1, réseau 192.168.* ou port 5173), on laisse vide pour que le code choisisse :4000
// - En prod, vous pouvez fixer l'URL Render ci-dessous
(function(){
	try {
		var isLocalNet = /^192\.168\./.test(location.hostname);
		var isDev = isLocalNet || location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.port === '5173';
		if(isDev){
			window.API_BASE_OVERRIDE = '';
		} else {
			// Décommentez pour forcer l’API Render en prod statique
			// window.API_BASE_OVERRIDE = 'https://suivi-byilhann-nico.onrender.com';
			window.API_BASE_OVERRIDE = '';
		}
	} catch(_) { window.API_BASE_OVERRIDE = ''; }
})();
