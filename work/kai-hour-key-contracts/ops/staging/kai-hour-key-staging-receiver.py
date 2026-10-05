#!/usr/bin/python3 -I
"""Forced SSH command; no paths, environment overrides, or shell evaluation."""
import os

os.execve('/usr/bin/sudo', ['sudo', '-n', '--', '/usr/local/libexec/kai-hour-key-staging-promote'],
          {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
