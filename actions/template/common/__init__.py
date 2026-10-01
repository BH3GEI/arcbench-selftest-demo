"""Grading logic shared by both channels: the local docker-compose server
(server/app/*.py, via the top-level `common` symlink -> actions/template/common)
and the GitHub Actions grader (scripts/*.py, runner/, grade.sh). Stdlib-only
so a bare `python3` can import it with no install step on either side.
"""
