var bignum = require('bignum');
var _ = require("underscore");

var Twit = require('twit')

var T = new Twit({
    consumer_key:         '***REMOVED***'
  , consumer_secret:      '***REMOVED***'
  , access_token:         '***REMOVED***'
  , access_token_secret:  '***REMOVED***'
});

var my_screen_name = "***REMOVED***";

var redis = require("redis");

var rc = redis.createClient();

rc.on("error", function (err) {
        console.log("Error " + err);
});

var mysql      = require('mysql');
var sql_conn = mysql.createConnection({
  host     : 'localhost',
  user     : 'root',
  password : '',
  database : 'condor',
  supportBigNumbers : 'true',
  timezone : 'UTC'
});

sql_conn.on('error', function(err) {
  console.log(err.code);
});

// Algo ripped from https://github.com/client9/snowflake2time/blob/master/python/snowflake.py
var snowflakeToUTC = function(sf) {
	return bignum(sf).shiftRight(22).add('1288834974657'); //  Returned value is in ms
}

var snowflakeToMinutesAgo = function(sf) {
	return Math.floor(((new Date).getTime()-snowflakeToUTC(sf))/(1000*60));
}

var addTweets = function(tweets,memo) {
	var values = tweets.map(
		function(d) {
			return [d.id_str, d.text, new Date(d.created_at), d.user.id_str];
		});
	sql_conn.query("REPLACE INTO tweets (tweet_id, text, created_at, user_id) VALUES ?", [values], function(err) {
	    if (err) console.log(err);
	});
}
	
var lists_info = []

for (var i=0;i < 1000;i++) {
	lists_info.push({index:i,since_id:0,timestamp:0});
}

var search_since_id = '0';

var refreshBoston = function() {
	T.get('search/tweets', {geocode:'42.3583,-71.0603,10mi', result_type: 'recent', count:100, since_id:search_since_id},
		function(err, reply) {
			if (err) {
				console.log("search/tweets");
				console.log(err);
			} else if (reply.statuses.length > 0) {
				search_since_id = reply.search_metadata.max_id_str;
				sql_conn.query("INSERT IGNORE INTO users (user_id) VALUES ?", [reply.statuses.map(function(d) {return [d.user.id_str];})], function(err) { if (err) console.log(err); });
				addTweets(reply.statuses,"search");
			}
		})
};

var list_fill_pointer = Math.floor((Math.random()*1000));
// var list_fill_pointer = 605;

var fillLists = function() {
	list_fill_pointer = (list_fill_pointer + 1) % 1000;
	// console.log("Fill Pointer: "+list_fill_pointer)
	rc.sdiff(['seen_uids','listed_uids'],
		function(err, reply) {
			var this_bucket = reply.filter(function(d) {return parseInt(d.slice(-3))==list_fill_pointer;}).slice(0,100);
			if (this_bucket.length > 0) {
				T.post('lists/members/create_all', {owner_screen_name: my_screen_name, slug: 'a'+list_fill_pointer, user_id: this_bucket.join(',')},
					function(err, reply) {
						if (err) {
							console.log('lists/members/create_all');
							console.log(err);
						} else {
							rc.sadd(['listed_uids'].concat(this_bucket));
							rc.scard('listed_uids',function(err, reply) {console.log("Users Seen: " + seen_users + "  Listed: "+reply);});
						}
					});
			}
		});
}

var refreshLists = function() {
	var l = _.min(lists_info,function(d) {return d.timestamp});
	var params = {owner_screen_name: my_screen_name, slug: 'a'+l.index, count:200};
	if (l.since_id > 0) {
		params.since_id = l.since_id.toString();
	}
	T.get('lists/statuses', params,
			function(err, reply) {
				if (err) {
					console.log('lists/statuses');
					console.log(params);
					console.log(err);
				} else if (reply.length > 0) {
					var new_since_id = bignum(reply[0].id_str);
					console.log("List a" + l.index + " was " + snowflakeToMinutesAgo(l.since_id) + " minutes behind, now " + snowflakeToMinutesAgo(new_since_id) + ".")
					lists_info[l.index].timestamp = snowflakeToUTC(new_since_id);
					lists_info[l.index].since_id = new_since_id;
					addTweets(reply,'list');
				} else {
					console.log("List a" + l.index + " gave us nothing.");
					lists_info[l.index].timestamp = (new Date).getTime();
				}
			});
}

var friends_state = {};
var followers_state = {};

var getRandomUser = function(callback) {
	sql_conn.query("SELECT COUNT(*) as num FROM users",
		function(err, rows) {
			sql_conn.query("SELECT user_id FROM users limit ?,1",Math.floor(Math.random()*rows[0].num),
				function(err, rows) {
					callback(rows[0].user_id);
				});
		});
}

var startRelationships = function() {
	if (friends_state.user_id === undefined) {
		getRandomUser(function(r) {
			friends_state = {user_id:r, cursor: -1, so_far:[], created_at: new Date};
			finishRelationships('friends',friends_state);
		});
	} else {
		finishRelationships('friends',friends_state);
	}

	if (followers_state.user_id === undefined) {
		getRandomUser(function(r) {
			followers_state = {user_id:r, cursor: -1, so_far:[], created_at: new Date};
			finishRelationships('followers',followers_state);
		});
	} else {
		finishRelationships('followers',followers_state);
	}
}

var finishRelationships = function(direction,state) {
	// console.log(state);
	T.get(direction+'/ids', {user_id:state.user_id, cursor:state.cursor},
		function (err,reply) {
			if (err) {
				console.log(direction+'/ids');
				console.log(err);
			} else {
				state.so_far = state.so_far.concat(reply.ids);
				if (reply.next_cursor_str === "0") {
					sql_conn.query("INSERT INTO relation_responses SET ?",
						{user_id: state.user_id,
						 direction: direction,
						 response: JSON.stringify(state.so_far),
						 created_at: state.created_at},
						function(err) {
	    					if (err) console.log(err);
						});
					delete state.user_id;
				} else {
					state.cursor = reply.next_cursor_str;
				}
			}
		});
};

var refreshBostonTrigger = setInterval(refreshBoston,(15*60*1000)/170);
var refreshListsTrigger = setInterval(refreshLists,(15*60*1000)/171);
var listsTrigger = setInterval(fillLists,(15*60*1000)/175);
var relationsTrigger = setInterval(startRelationships,61*1000);
