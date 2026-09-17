#!/bin/bash
# Claude Code passes JSON with the session data to the script on stdin.
# The script pulls out the fields it needs and prints one line, and that line is
# the status line.
# The session and week limits only arrive when signed in through a Pro or Max
# subscription.

input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "?"')
ctx=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
five=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
week=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')

line="$model"
[ -n "$ctx" ]  && line="$line | context ${ctx%.*}%"
[ -n "$five" ] && line="$line | session(5h) ${five%.*}%"
[ -n "$week" ] && line="$line | week ${week%.*}%"

echo "$line"
