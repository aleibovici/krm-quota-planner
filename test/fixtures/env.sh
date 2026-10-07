# Excerpt of services/kai-scheduler/scripts/env.sh (sample GitOps repo) — the
# expectation variables verify.sh compares the live queues against.
DEPARTMENT=platform
# project:namespace:queue:gpu-deserved:gpu-limit
PHASE1_PROJECTS="kai-verify:kai-verify:kai-verify-rtx:0:1"
TENANT_PROJECTS="workspace:workspace:workspace-rtx:3:3 benchmark:benchmark:benchmark-rtx:1:4"   # the tenant namespaces
DEPT_QUEUE="platform-rtx:4:4"                       # queue:gpu-deserved:gpu-limit
OLD_QUEUES="legacy-rtx workspace benchmark kai-verify"   # Queues that existed before KRM; removed once the Project queues are Ready
VERIFY_PROJECT=kai-verify
VERIFY_QUEUE=kai-verify-rtx
