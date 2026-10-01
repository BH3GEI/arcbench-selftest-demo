FROM python:3.12-slim

WORKDIR /srv
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
# The real common/ module lives at actions/template/common/ (the GitHub
# Actions grader template is self-contained and portable; the repo-root
# `common` symlink is for local, non-Docker use e.g. pytest). Copy the real
# directory directly so the image doesn't depend on resolving a symlink.
COPY actions/template/common ./common
ENV PYTHONPATH=/srv

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
