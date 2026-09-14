CREATE TABLE "workflow_step_claims" (
	"execution_id" text NOT NULL,
	"node_id" text NOT NULL,
	"for_each_node_id" text DEFAULT '' NOT NULL,
	"iteration_index" integer DEFAULT -1 NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_step_claims_pk" PRIMARY KEY("execution_id","node_id","for_each_node_id","iteration_index")
);
--> statement-breakpoint
ALTER TABLE "workflow_step_claims" ADD CONSTRAINT "workflow_step_claims_execution_id_workflow_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;