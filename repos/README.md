# Project Repositories

Place independent Git repositories in this directory.

Use the workspace helper when cloning a new project:

```bash
../scripts/add-repo.sh git@github.com:you/project.git
```

Every direct child under this directory is treated as independent unless `repos.yaml` or the user says otherwise.
