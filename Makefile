.PHONY: setup up start test reset infra

setup:
	./setup.sh

start:
	./start.sh

test:
	./test-api.sh

reset:
	./reset.sh

infra:
	docker compose -f infra/docker-compose.yml up -d
