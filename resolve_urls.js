var http = require('http');
var https = require('https');
var url = require('url');
var _ = require("underscore");

var mysql      = require('mysql');
var sql_conn = mysql.createConnection({
  host     : '***REMOVED***',
  user     : 'condor',
  password : 'condor',
  database : 'condor',
  supportBigNumbers : 'true',
  timezone : 'UTC',
  charset: 'UTF8MB4_UNICODE_CI'
});

sql_conn.on('error', function(err) {
  console.log(err);
});


var url_queue = [];
waiting_count = 0;

var getMoreUrls = function() {
	if (url_queue.length == 0) {
		sql_conn.query("SELECT url, url_hash FROM tweeted_urls WHERE real_url IS NULL", function(e,rows) {
			if (e) {
				console.log(["mysql select error",e]);
			} else {
				url_queue = rows;
			}
		});
	}
}

var deriveDomains = function() {
	var goInsert = function() {
		console.log(out_rows.length);
		var row = out_rows.pop();
		sql_conn.query("UPDATE tweeted_urls SET domain = ? WHERE url_hash = ?", row,
			function() {if (out_rows.length > 0) setTimeout(goInsert,0);});
	}
	var out_rows;
	sql_conn.query("SELECT url_hash, real_url FROM tweeted_urls WHERE domain IS NULL AND real_url IS NOT NULL", function(e,rows) {
		out_rows = rows.map(function (row) {
			return [getDomain(row.real_url),row.url_hash]
		});
		setTimeout(goInsert,0);
	});
}

var getAndResolve = function() {
	var target = url_queue.pop();
	if (target === undefined)
		return;
	var redirects_left = 5;
	var current_url = target.url;
	var redirect_callback = function(res) {
		// console.log(res.statusCode);
		res.socket.destroy()
		if ((res.statusCode >= 300) && (res.statusCode < 400) && ('location' in res.headers)) {
			current_url = url.resolve(current_url,res.headers.location);
			if (redirects_left == 0) {
				finish();
			} else {
				redirects_left--;
				follow_redirect();
			}
		} else {
			if (res.statusCode == 200) {
				finish();
			}
		}
	};
	var finish = function() {
		// console.log([target.url,normalizeURL(current_url),redirects_left]);
		var normed_url = normalizeURL(current_url);
		var domain = getDomain(current_url);
		waiting_count++
		sql_conn.query("UPDATE tweeted_urls SET real_url = ?, domain = ? WHERE url_hash = ?", [normed_url,domain,target.url_hash],
			function(e,res) {
				console.log(--waiting_count);
				if (e) {
					console.log(["mysql update error",e]);
				} else {
					// console.log({in:target.url,out:normed_url,redirects_left:redirects_left,affected_rows:res.affectedRows});
				}
			});
	}
	var follow_redirect = function() {
		var options = url.parse(current_url);
		options.method="GET";
		options.agent=false;
		options.headers={	'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
							'Referer':'http://google.com'};
		// console.log(current_url);
		if (options.protocol === 'https:') {
			var req = https.request(options, redirect_callback).on('error', function(e) {console.log(["https error",e,current_url]);});
			req.end();
		} else if (options.protocol === 'http:') {
			var req = http.request(options, redirect_callback).on('error', function(e) {console.log(["http error",e,current_url]);});
			req.end();
		}
	}
	follow_redirect();
}

var getDomain = function(in_url) {
	var host = url.parse(in_url).host;
	if (host.slice(0,4)==="www.")
		return host.slice(4);
	else
		return host;
}

var normalizeURL = function(in_url) {
	var parsed = url.parse(in_url,true);
	delete parsed.search;
	delete parsed.hash;
	delete parsed.path;
	delete parsed.href;
	Object.keys(parsed.query).filter(function(d) {return d.slice(0,4)==="utm_"}).forEach(function(d) {delete parsed.query[d]})
	return url.format(parsed)
}

// deriveDomains();
setInterval(getAndResolve,10);
setInterval(getMoreUrls,1000);
getMoreUrls();

