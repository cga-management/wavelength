# Consumed by later build-order steps (the model gateway, app deploys) and by CI.

output "project_id" {
  description = "Platform project id."
  value       = var.project_id
}

output "region" {
  description = "Platform region."
  value       = var.region
}

output "network_id" {
  description = "Platform VPC self link / id."
  value       = google_compute_network.platform.id
}

output "subnet_id" {
  description = "Apps subnet id (Cloud Run attaches here via Direct VPC egress)."
  value       = google_compute_subnetwork.apps.id
}

output "artifact_registry_repo" {
  description = "Artifact Registry repo path for image push/pull (<region>-docker.pkg.dev/<project>/<repo>)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.platform.repository_id}"
}

output "app_service_account_email" {
  description = "Email of the app workload identity (Cloud Run runs as this SA)."
  value       = google_service_account.app.email
}

output "db_instance_name" {
  description = "Shared Cloud SQL instance name."
  value       = google_sql_database_instance.shared.name
}

output "db_connection_name" {
  description = "Cloud SQL connection name (project:region:instance), for the SQL connector / proxy."
  value       = google_sql_database_instance.shared.connection_name
}

output "db_private_ip" {
  description = "Shared Cloud SQL private IP. Bifrost/apps use this as WL_DB_HOST."
  value       = google_sql_database_instance.shared.private_ip_address
}

output "labels" {
  description = "Standard label set, reused by stacks that deploy into the project."
  value       = local.labels
}

output "anthropic_secret_id" {
  description = "Secret Manager secret id for the operator-supplied Anthropic key."
  value       = google_secret_manager_secret.anthropic_api_key.secret_id
}

output "replicate_secret_id" {
  description = "Secret Manager secret id for the operator-supplied Replicate key."
  value       = google_secret_manager_secret.replicate_api_key.secret_id
}

output "db_password_secret_id" {
  description = "Secret Manager secret id for the shared DB admin password."
  value       = google_secret_manager_secret.db_admin_password.secret_id
}

output "outline_database_url_secret_id" {
  description = "Secret Manager secret id for the Outline app's full DATABASE_URL."
  value       = google_secret_manager_secret.outline_database_url.secret_id
}

output "wl_admin_database" {
  description = "Name of the shared admin-registry database (wl_admin) on the shared Cloud SQL. Apps read platform_admins from it (connecting on db_private_ip as the shared admin)."
  value       = google_sql_database.wl_admin.name
}

output "labs_dns_zone" {
  description = "Cloud DNS managed-zone name for the delegated app subdomain. App deploys create <app>.<zone> records in it."
  value       = google_dns_managed_zone.labs.name
}

output "labs_dns_domain" {
  description = "DNS name of the delegated app subdomain zone (with trailing dot)."
  value       = google_dns_managed_zone.labs.dns_name
}

output "labs_dns_nameservers" {
  description = "Nameservers for the app subdomain. Add these as NS records for the subdomain at your apex (wherever the apex is managed) to delegate it to Cloud DNS."
  value       = google_dns_managed_zone.labs.name_servers
}

output "telemetry_dataset_id" {
  description = "BigQuery dataset id for platform usage telemetry (LB + IAP audit log sink). The future admin-portal usage collector reads its aggregates from here."
  value       = google_bigquery_dataset.telemetry.dataset_id
}

output "certificate_map_id" {
  description = "Certificate Manager certificate map id (projects/<p>/locations/global/certificateMaps/<name>). App LBs pass this to the iap-lb module's certificate_map input for instant wildcard TLS."
  value       = google_certificate_manager_certificate_map.wildcard.id
}
