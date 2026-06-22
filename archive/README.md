# Archive job

Inactivity detection, full-database snapshot, cold-storage push (Blob, Cool then Archive), retention clock, restore verification, then teardown. Activity is measured at the platform (ingress, SSO sign-ins, last commit), never inside the app.

**Status:** placeholder. TODO: implement the scheduled job and the restore-verify step.
