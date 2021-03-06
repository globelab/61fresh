var http = require('http');
var https = require('https');
var url = require('url');
var _ = require("underscore");
var crypto = require('crypto');

var config;
try {
	config = require(__dirname + '/config-local.json');
} catch (e) {
	config = require(__dirname + '/config/config.json')
}

var mysql      = require('mysql');
var sql_conn = mysql.createConnection({
  host     : config.mysql.host,
  port     : config.mysql.port,
  user     : config.mysql.user,
  password : config.mysql.password,
  database : config.mysql.database,
  supportBigNumbers : 'true',
  timezone : 'UTC',
  charset: 'UTF8MB4_UNICODE_CI'
});

sql_conn.on('error', function(err) {
  console.log(err);
});


var url_queue = [];
var known_urls = {};

var refreshing_urls = false;

var getMoreUrls = function() {
	if (url_queue.length == 0 && !refreshing_urls) {
		refreshing_urls = true;
		sql_conn.query("SELECT id, url, url_hash FROM tweeted_urls WHERE real_url_hash IS NULL AND created_at > '2014-03-22'", function(e,rows) {
			refreshing_urls = false;
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

var addRealURLHash = function() {
	var goInsert = function() {
		console.log(out_rows.length);
		var row = out_rows.pop();
		sql_conn.query("UPDATE tweeted_urls SET real_url_hash = ? WHERE url_hash = ?", row,
			function() {if (out_rows.length > 0) setTimeout(goInsert,0);});
	}
	var out_rows;
	sql_conn.query("SELECT url_hash, real_url FROM tweeted_urls WHERE real_url IS NOT NULL AND real_url_hash IS NULL GROUP BY url_hash", function(e,rows) {
		out_rows = rows.map(function (row) {
			return [crypto.createHash('sha1').update(row.real_url).digest("hex"),row.url_hash]
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
			var new_url = url.resolve(current_url,res.headers.location);
			known_urls[current_url] = new_url;
			current_url = new_url;
			if (redirects_left == 0) {
				finish();
			} else {
				redirects_left--;
				follow_redirect();
			}
		} else {
			if (res.statusCode == 200) {
				finish();
            } else {
                error_out("status code: " + res.statusCode);
            }
		}
	};
	var finish = function() {
		known_urls[current_url] = 'final';
		// console.log([target.url,normalizeURL(current_url),redirects_left]);
		var normed_url = normalizeURL(current_url);
		var real_url_hash = crypto.createHash('sha1').update(normed_url).digest("hex");
		var domain = getDomain(current_url);
	//	if (domain === "unfollowers.com") return;
		//console.log("resolved... going to sql");
		// waiting_count++
		sql_conn.query("UPDATE tweeted_urls SET real_url = ?, real_url_hash = ?, domain = ? WHERE id = ?", [normed_url,real_url_hash,domain,target.id],
			function(e,res) {
				//console.log("sql done")
				// console.log(--waiting_count);
				if (e) {
					console.log(["mysql update error",e]);
				} else {
					// console.log({in:target.url,out:normed_url,redirects_left:redirects_left,affected_rows:res.affectedRows});
				}
			});
	}
	var error_out = function(e) {
		console.log(['http(s) error',e,current_url]);
		sql_conn.query("UPDATE tweeted_urls SET real_url = ?, real_url_hash = ? WHERE id = ?", ['error','error',target.id],
			function(e,res) {
				if (e) {
					console.log(["mysql update error",e]);
				}
			});
	}

	var follow_redirect = function() {
		if (current_url in known_urls) {
			if (known_urls[current_url] === "final") {
				setTimeout(finish,0);
			} else {
				current_url = known_urls[current_url];
				if (redirects_left == 0) {
					finish();
				} else {
					redirects_left--;
					follow_redirect();
				}
			}
		} else {
			var options = url.parse(current_url);
			options.method="GET";
			options.agent=false;
			options.headers={	'User-Agent':'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
								'Referer':'http://google.com'};
			// console.log(current_url);
			if (options.protocol === 'https:') {
				var req = https.request(options, redirect_callback).on('error', error_out);
				req.end();
			} else if (options.protocol === 'http:') {
				var req = http.request(options, redirect_callback).on('error', error_out);
				req.end();
			}
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
	Object.keys(parsed.query).filter(function(d) {return d.slice(0,4)==="utm_"}).forEach(function(d) {delete parsed.query[d]});
	['camp', 'SREF', 'dlvrit', 's_campaign', 'rssfeed', 'rss_id'].forEach(function(d) {delete parsed.query[d]});
	return url.format(parsed)
}

// deriveDomains();
// addRealURLHash();
setInterval(getAndResolve,50);
setInterval(getMoreUrls,1000);
getMoreUrls();
setTimeout(process.exit,5*60*60*1000);
