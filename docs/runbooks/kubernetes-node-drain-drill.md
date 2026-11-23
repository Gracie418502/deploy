# Kubernetes Node-Drain Drill Runbook

## Purpose

This runbook describes a repeatable **staging** drill that drains a Kubernetes node while
observing application availability and pod scheduling. It validates that PodDisruptionBudgets
(PDBs), replica counts, and scheduling behavior keep the service available during planned
node maintenance.

> **Scope:** Staging clusters only. Do **not** run this drill against production without a
> separate change-approval and a maintenance window.

## Preconditions

Before starting the drill, confirm all of the following:

- [ ] A **staging** cluster is available and `kubectl` is pointed at the correct context
      (`kubectl config current-context`).
- [ ] The backend Deployment is running with **at least 2 replicas**
      (`kubectl get deploy -n <namespace>`).
- [ ] PDBs from `k8s/pdb.yaml` are applied
      (`kubectl apply -f k8s/pdb.yaml`).
- [ ] The cluster has **more than one schedulable node** so evicted pods can be rescheduled.
- [ ] Monitoring/observability is reachable so request error rate can be observed during the
      drill.
- [ ] You have a way to record results (see the template at the end of this document).

Set up shell variables for convenience:

```sh
export NS=<namespace>
export DEPLOY=<backend-deployment-name>
```

## Drill Steps

### 1. Identify a node to drain

List nodes and pick a worker node that currently hosts at least one backend pod:

```sh
kubectl get nodes -o wide
kubectl get pods -n "$NS" -o wide
```

Record the chosen node name:

```sh
export NODE=<node-name>
```

### 2. Record the baseline

Capture the starting state so recovery can be compared against it:

```sh
kubectl get pods -n "$NS" -o wide
kubectl get pdb -n "$NS"
kubectl get hpa -n "$NS"
```

### 3. Cordon the node

Mark the node unschedulable so no new pods land on it:

```sh
kubectl cordon "$NODE"
kubectl get nodes
```

The node should show `SchedulingDisabled`.

### 4. Start observing pod movement

In a separate terminal, watch pod placement and readiness:

```sh
kubectl get pods -n "$NS" -o wide -w
```

In another terminal, watch the PDB state:

```sh
kubectl describe pdb -n "$NS"
```

### 5. Drain the node

Drain the node, evicting pods while respecting PDBs:

```sh
kubectl drain "$NODE" --ignore-daemonsets --delete-emptydir-data
```

- `--ignore-daemonsets` skips DaemonSet-managed pods (they are expected to remain).
- `--delete-emptydir-data` allows eviction of pods using `emptyDir` volumes.

**Expected behavior:** the drain evicts backend pods one at a time (see the disruption-budget
section below). If evicting a pod would violate the PDB, the drain **blocks** and waits until
the PDB allows another eviction.

### 6. Observe eviction and rescheduling

While the drain runs, watch for:

- Backend pods transitioning to `Terminating` on the drained node.
- Replacement pods appearing as `Pending` and then `Running`/`Ready` on other nodes.
- The PDB `ALLOWED DISRUPTIONS` value dropping to `0` while a pod is being evicted and
  returning to `1` once the replacement is Ready.

## Expected Disruption-Budget Behavior

The backend PDB uses `minAvailable: 1`. With this setting:

- **At most one backend pod is evicted at a time.** The drain evicts a pod, waits for the
  replacement to become Ready, then proceeds to the next pod.
- **The drain blocks if an eviction would violate the PDB.** If the remaining Ready replicas
  would drop below `minAvailable`, `kubectl drain` waits rather than forcing the eviction.
- `kubectl describe pdb -n "$NS"` should show `ALLOWED DISRUPTIONS` oscillating between `0`
  and `1` during the drill, never allowing more than one simultaneous eviction.

If the drain proceeds faster than one pod at a time, or if `ALLOWED DISRUPTIONS` exceeds `1`,
stop the drill and investigate the PDB configuration.

## Measuring Recovery Timing

Record the following for each evicted backend pod:

- **Eviction time:** timestamp when the pod enters `Terminating`.
- **Ready time:** timestamp when the replacement pod reports `Ready` on another node.
- **Recovery duration:** difference between the two (time from eviction to Ready on another
  node).
- **Request error rate:** observe the service's error rate (from monitoring dashboards or
  logs) during the drill window. Note any spikes and their duration.

Useful commands:

```sh
# Watch readiness transitions with timestamps
kubectl get pods -n "$NS" -o wide -w

# Inspect a specific pod's events and readiness
kubectl describe pod -n "$NS" <pod-name>
```

## Cleanup Steps

After the drill completes:

1. **Uncordon the node** so it can schedule pods again:

   ```sh
   kubectl uncordon "$NODE"
   kubectl get nodes
   ```

   The node should no longer show `SchedulingDisabled`.

2. **Verify all pods are Running and Ready:**

   ```sh
   kubectl get pods -n "$NS" -o wide
   ```

   Confirm every backend pod is `Running` with all containers `Ready`.

3. **Confirm the HPA returns to baseline:**

   ```sh
   kubectl get hpa -n "$NS"
   ```

   Replica count should return to the pre-drill baseline once load normalizes.

4. **Confirm PDB health:**

   ```sh
   kubectl describe pdb -n "$NS"
   ```

   `ALLOWED DISRUPTIONS` should be back to its normal value.

## Results-Recording Template

Copy this template into the drill record and fill it in:

```
Node-Drain Drill Results
========================
Date:                     ___________
Operator:                 ___________
Cluster / context:        ___________
Namespace:                ___________
Node drained:             ___________
Backend replicas (pre):   ___________
PDB config:               minAvailable: 1

Disruption-budget behavior
--------------------------
Max simultaneous evictions observed:  ___________
Did drain block on PDB as expected?   [ ] Yes  [ ] No
Notes: ___________________________________________

Recovery timing
---------------
Pod 1: evicted at ______  Ready at ______  duration ______
Pod 2: evicted at ______  Ready at ______  duration ______
Pod 3: evicted at ______  Ready at ______  duration ______

Request error rate during drill:  ___________
Peak error rate / duration:       ___________

Cleanup
-------
Node uncordoned:                  [ ] Yes
All pods Running and Ready:       [ ] Yes
HPA returned to baseline:         [ ] Yes
PDB ALLOWED DISRUPTIONS normal:   [ ] Yes

Observations / follow-ups
-------------------------
_________________________________________________
_________________________________________________